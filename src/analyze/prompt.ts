import { createInterface, type Interface } from 'node:readline';
import type { ReadableLike, Reporter } from '@govplane/cli';

/**
 * Terminal prompting.
 *
 * `analyze` is the one CLI Toolkit command that asks questions: the spec
 * requires confirmation before overwriting a draft, and `--interactive` steps
 * through discoveries with the developer.
 *
 * A prompt is only ever offered when there is someone to answer it. Without a
 * TTY — a CI job, a piped script — the caller falls back to a flag, because a
 * command that blocks forever waiting on nobody is a broken command.
 */

export interface Prompter {
  /** Whether prompting is possible at all. */
  readonly interactive: boolean;
  ask(question: string, choices: string[], fallback: string): Promise<string>;
  askLine(question: string): Promise<string>;
  close(): void;
}

const normalise = (value: string): string => value.trim().toLowerCase();

class ReadlinePrompter implements Prompter {
  readonly interactive = true;

  private surface: Interface | null = null;

  private lines: AsyncIterator<string> | null = null;

  /** Set once input ends — Ctrl-D, or a script that ran out of answers. */
  private ended = false;

  constructor(
    private readonly input: ReadableLike,
    private readonly reporter: Reporter,
  ) {}

  /**
   * Lines pulled on demand rather than pushed at us.
   *
   * `rl.question()` attaches a one-shot listener, so any line that arrives
   * while no question is outstanding is simply dropped. That is invisible with
   * a human typing — they only answer when asked — and silently loses answers
   * from anything that supplies input faster: a piped script, a heredoc, a
   * test. The async iterator buffers instead, so every line is delivered to the
   * question that asked for it.
   */
  private iterator(): AsyncIterator<string> {
    if (this.lines === null) {
      this.surface = createInterface({ input: this.input });
      this.lines = this.surface[Symbol.asyncIterator]();
    }
    return this.lines;
  }

  /**
   * Asks one question.
   *
   * Once input has ended there is nobody left to answer, so every further
   * question resolves empty and the caller falls back to its default. Failing
   * instead would turn a Ctrl-D half way through a review into a crash that
   * loses the answers already given.
   */
  async askLine(question: string): Promise<string> {
    if (this.ended) {
      return '';
    }

    const lines = this.iterator();
    this.reporter.line(question);

    try {
      const next = await lines.next();
      if (next.done === true) {
        this.ended = true;
        return '';
      }
      return String(next.value).trim();
    } catch {
      this.ended = true;
      return '';
    }
  }

  async ask(question: string, choices: string[], fallback: string): Promise<string> {
    const answer = normalise(await this.askLine(`${question} [${choices.join('/')}]`));

    if (answer === '') {
      return fallback;
    }
    // Accept a unique prefix, so "o" selects "overwrite".
    const matches = choices.filter((choice) => choice.toLowerCase().startsWith(answer));
    if (matches.length === 1) {
      return matches[0] as string;
    }
    return choices.includes(answer) ? answer : fallback;
  }

  close(): void {
    this.surface?.close();
    this.surface = null;
    this.lines = null;
    this.ended = true;
  }
}

/** A prompter that never asks. Every question resolves to its fallback. */
class SilentPrompter implements Prompter {
  readonly interactive = false;

  async ask(_question: string, _choices: string[], fallback: string): Promise<string> {
    return fallback;
  }

  async askLine(): Promise<string> {
    return '';
  }

  close(): void {
    // Nothing to close.
  }
}

export interface PrompterOptions {
  stdin?: ReadableLike | undefined;
  reporter: Reporter;
  /** Set when the caller knows prompting is not wanted, such as `--quiet`. */
  disabled?: boolean;
}

/**
 * Builds a prompter for this invocation.
 *
 * `isTTY` is the test: an interactive terminal has one, a pipe does not. Tests
 * pass a real readable stream with `isTTY` set, so the prompting path under
 * test is the one that ships.
 */
export const createPrompter = (options: PrompterOptions): Prompter => {
  const { stdin } = options;
  if (options.disabled === true || stdin === undefined || stdin.isTTY !== true) {
    return new SilentPrompter();
  }
  return new ReadlinePrompter(stdin, options.reporter);
};
