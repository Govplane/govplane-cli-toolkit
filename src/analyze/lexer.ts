/**
 * A JavaScript/TypeScript tokenizer.
 *
 * `analyze` needs to find `evaluate()` calls and read their arguments
 * structurally. The spec requires AST analysis rather than regular expressions,
 * and for good reason: a regex cannot tell an `evaluate(` inside a comment or a
 * string from a real call, and cannot find the end of an argument that contains
 * nested braces, arrow functions or template literals.
 *
 * The project also mandates near-zero runtime dependencies. Promoting the
 * TypeScript compiler to a runtime dependency would add tens of megabytes to a
 * toolkit that currently ships two, for a fraction of one percent of its
 * surface. So this is a purpose-built lexer over the subset the analyzer
 * actually reads, paired with the expression parser in `expression.ts`.
 *
 * It is a lexer, not a full parser: it produces a correct token stream with
 * positions, and the expression parser builds a value tree from the tokens that
 * matter. Anything it cannot resolve is preserved verbatim rather than guessed
 * at, which is what the spec asks for.
 */

export type TokenType = 'identifier' | 'punctuator' | 'string' | 'template' | 'number' | 'regex';

export interface Token {
  type: TokenType;
  /** Exact source text, including quotes or delimiters. */
  raw: string;
  /** Decoded value for strings; identical to `raw` otherwise. */
  value: string;
  start: number;
  end: number;
  /** 1-based, as editors and stack traces report them. */
  line: number;
  column: number;
}

/** Longest-first, so `>>>=` is never mistaken for `>>` followed by `>=`. */
const PUNCTUATORS = [
  '>>>=',
  '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%',
  '&', '|', '^', '!', '~', '?', ':', '=', '.', '@', '#',
];

/**
 * Keywords after which a `/` begins a regular expression rather than a
 * division. `return /x/.test(s)` is a regex; `count / total` is not.
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
]);

const isIdentifierStart = (code: number): boolean => (
  (code >= 97 && code <= 122) // a-z
  || (code >= 65 && code <= 90) // A-Z
  || code === 36 // $
  || code === 95 // _
  || code > 127 // treat any non-ASCII as an identifier character
);

const isIdentifierPart = (code: number): boolean => (
  isIdentifierStart(code) || (code >= 48 && code <= 57)
);

const isDigit = (code: number): boolean => code >= 48 && code <= 57;

const HEX = /^[0-9a-fA-F]+$/;

/** Decodes the escape sequences that can appear in a string or template. */
const decode = (raw: string): string => {
  if (!raw.includes('\\')) {
    return raw;
  }

  let out = '';
  let index = 0;

  while (index < raw.length) {
    const char = raw[index] as string;
    if (char !== '\\') {
      out += char;
      index += 1;
      continue;
    }

    const next = raw[index + 1];
    index += 2;

    switch (next) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '0': out += '\0'; break;
      case '\n': break; // line continuation
      case 'x': {
        const hex = raw.slice(index, index + 2);
        if (HEX.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          index += 2;
        } else {
          out += 'x';
        }
        break;
      }
      case 'u': {
        if (raw[index] === '{') {
          const close = raw.indexOf('}', index);
          const hex = close === -1 ? '' : raw.slice(index + 1, close);
          if (hex !== '' && HEX.test(hex)) {
            out += String.fromCodePoint(parseInt(hex, 16));
            index = close + 1;
          } else {
            out += 'u';
          }
          break;
        }
        const hex = raw.slice(index, index + 4);
        if (HEX.test(hex) && hex.length === 4) {
          out += String.fromCharCode(parseInt(hex, 16));
          index += 4;
        } else {
          out += 'u';
        }
        break;
      }
      default:
        out += next ?? '';
    }
  }

  return out;
};

/**
 * Decides whether a `/` at this point starts a regular expression.
 *
 * The rule is positional: a regex can only appear where a value is expected.
 * After an identifier, a number, or a closing `)` or `]`, a `/` is division.
 */
const regexCanFollow = (previous: Token | undefined): boolean => {
  if (previous === undefined) {
    return true;
  }
  if (previous.type === 'identifier') {
    return REGEX_PRECEDING_KEYWORDS.has(previous.value);
  }
  if (previous.type === 'number' || previous.type === 'string'
    || previous.type === 'template' || previous.type === 'regex') {
    return false;
  }
  // A punctuator: everything expects a value next except these closers.
  // `}` is genuinely ambiguous (block end vs object end); block end is far more
  // common at the position a `/` follows, and `scanRegex` refuses to run past a
  // newline, so a wrong guess degrades to division rather than eating code.
  return previous.value !== ')' && previous.value !== ']';
};

export interface LexResult {
  tokens: Token[];
  /** True when the source contained something the lexer could not make sense of. */
  recovered: boolean;
}

/**
 * Tokenizes a source file.
 *
 * Never throws. Source that cannot be tokenized cleanly — a partial file, a
 * syntax error, a language this lexer does not know — yields whatever tokens
 * were readable and sets `recovered`. A source tree being analysed is not
 * guaranteed to compile, and one bad file must not fail the run.
 */
export const tokenize = (source: string): LexResult => {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let lineStart = 0;
  let recovered = false;

  const columnAt = (offset: number): number => offset - lineStart + 1;

  const push = (type: TokenType, start: number, end: number, value?: string): void => {
    tokens.push({
      type,
      raw: source.slice(start, end),
      value: value ?? source.slice(start, end),
      start,
      end,
      line,
      column: columnAt(start),
    });
  };

  /** Advances over a span, keeping the line counter accurate. */
  const advanceOver = (from: number, to: number): void => {
    for (let at = from; at < to; at += 1) {
      if (source.charCodeAt(at) === 10) {
        line += 1;
        lineStart = at + 1;
      }
    }
    index = to;
  };

  const scanTemplate = (start: number): number => {
    // Templates nest: `${ `inner` }` is legal, as is `${ {a:1} }`.
    let at = start + 1;
    let depth = 0;

    while (at < source.length) {
      const char = source[at];

      if (char === '\\') {
        at += 2;
        continue;
      }
      if (depth === 0 && char === '`') {
        return at + 1;
      }
      if (depth === 0 && char === '$' && source[at + 1] === '{') {
        depth = 1;
        at += 2;
        continue;
      }
      if (depth > 0) {
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
        else if (char === '`') {
          // A nested template inside the substitution.
          at = scanTemplate(at);
          continue;
        }
      }
      at += 1;
    }

    return at;
  };

  const scanRegex = (start: number): number | null => {
    let at = start + 1;
    let inClass = false;

    while (at < source.length) {
      const char = source[at];
      if (char === '\\') {
        at += 2;
        continue;
      }
      // A regex literal cannot span a line. Hitting one means this `/` was
      // division after all, and the caller should treat it as a punctuator.
      if (char === '\n') {
        return null;
      }
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) {
        at += 1;
        while (at < source.length && isIdentifierPart(source.charCodeAt(at))) {
          at += 1;
        }
        return at;
      }
      at += 1;
    }

    return null;
  };

  while (index < source.length) {
    const code = source.charCodeAt(index);

    // Whitespace and newlines.
    if (code === 10) {
      index += 1;
      line += 1;
      lineStart = index;
      continue;
    }
    if (code === 32 || code === 9 || code === 13 || code === 12 || code === 11 || code === 0xFEFF) {
      index += 1;
      continue;
    }

    // Comments.
    if (code === 47 && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (code === 47 && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) {
        recovered = true;
        advanceOver(index, source.length);
        break;
      }
      advanceOver(index, end + 2);
      continue;
    }

    // Strings.
    if (code === 34 || code === 39) {
      const quote = source[index] as string;
      let at = index + 1;
      let terminated = false;

      while (at < source.length) {
        const char = source[at];
        if (char === '\\') {
          at += 2;
          continue;
        }
        if (char === quote) {
          terminated = true;
          at += 1;
          break;
        }
        // An unterminated string: bail out at the line end rather than
        // swallowing the rest of the file.
        if (char === '\n') {
          break;
        }
        at += 1;
      }

      if (!terminated) {
        recovered = true;
        push('string', index, at, decode(source.slice(index + 1, at)));
        advanceOver(index, at);
        continue;
      }

      push('string', index, at, decode(source.slice(index + 1, at - 1)));
      advanceOver(index, at);
      continue;
    }

    // Template literals.
    if (code === 96) {
      const end = scanTemplate(index);
      const start = index;
      push('template', start, end);
      advanceOver(start, end);
      continue;
    }

    // Numbers.
    if (isDigit(code) || (code === 46 && isDigit(source.charCodeAt(index + 1)))) {
      let at = index;
      while (at < source.length) {
        const char = source.charCodeAt(at);
        const text = source[at] as string;
        if (isDigit(char) || char === 46 || char === 95
          || 'xXbBoOeEaAbBcCdDfF'.includes(text) || char === 110) {
          // An exponent sign is part of the number; a bare `-` is not.
          at += 1;
          continue;
        }
        if ((text === '+' || text === '-')
          && 'eE'.includes(source[at - 1] as string)) {
          at += 1;
          continue;
        }
        break;
      }
      push('number', index, at);
      index = at;
      continue;
    }

    // Identifiers and keywords.
    if (isIdentifierStart(code)) {
      let at = index + 1;
      while (at < source.length && isIdentifierPart(source.charCodeAt(at))) {
        at += 1;
      }
      push('identifier', index, at);
      index = at;
      continue;
    }

    // Regular expressions, where one can appear.
    if (code === 47 && regexCanFollow(tokens[tokens.length - 1])) {
      const end = scanRegex(index);
      if (end !== null) {
        push('regex', index, end);
        index = end;
        continue;
      }
    }

    // Punctuators. `at` is captured so the predicate does not close over the
    // loop counter.
    const at = index;
    const punctuator = PUNCTUATORS.find((candidate) => source.startsWith(candidate, at));
    if (punctuator !== undefined) {
      push('punctuator', index, index + punctuator.length);
      index += punctuator.length;
      continue;
    }

    // Anything else is not something this lexer models. Skip the character and
    // carry on: one unknown byte must not cost the whole file.
    recovered = true;
    index += 1;
  }

  return { tokens, recovered };
};
