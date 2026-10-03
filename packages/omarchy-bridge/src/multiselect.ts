/** A minimal terminal multiselect: arrows or j/k move, space toggles, a toggles all, enter confirms. */
import { emitKeypressEvents } from "node:readline";

export interface Choice<T> {
  readonly value: T;
  readonly label: string;
  readonly hint?: string;
  readonly checked?: boolean;
  /** Shown greyed out and cannot be selected. */
  readonly disabled?: boolean;
}

interface Key {
  readonly name?: string;
  readonly ctrl?: boolean;
}

/** Resolves with the selected values, or `null` when the user cancels (Esc, q, Ctrl-C). */
export function multiselect<T>(message: string, choices: ReadonlyArray<Choice<T>>): Promise<T[] | null> {
  const input = process.stdin;
  const output = process.stdout;
  const selected = choices.map((choice) => choice.checked === true && choice.disabled !== true);
  const enabled = choices.flatMap((choice, index) => (choice.disabled === true ? [] : [index]));
  let cursor = enabled[0] ?? 0;
  let drawn = 0;

  const render = (done: boolean): void => {
    if (drawn > 0) output.write(`\x1b[${drawn}A\x1b[0J`);
    const lines = [`? ${message}${done ? "" : "  (space toggles, a all, enter confirms)"}`];
    if (!done) {
      choices.forEach((choice, index) => {
        const pointer = index === cursor ? ">" : " ";
        const box = choice.disabled === true ? "-" : selected[index] ? "x" : " ";
        const text = `${pointer} [${box}] ${choice.label}${choice.hint === undefined ? "" : `  ${choice.hint}`}`;
        lines.push(choice.disabled === true ? `\x1b[2m${text}\x1b[0m` : text);
      });
    } else {
      const picked = choices.filter((_, index) => selected[index]).map((choice) => choice.label);
      lines[0] += `  ${picked.length === 0 ? "none" : picked.join(", ")}`;
    }
    output.write(`${lines.join("\n")}\n`);
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    const finish = (result: T[] | null): void => {
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
      output.write("\x1b[?25h");
      resolve(result);
    };
    const move = (step: number): void => {
      if (enabled.length === 0) return;
      const at = enabled.indexOf(cursor);
      cursor = enabled[(at + step + enabled.length) % enabled.length] ?? cursor;
    };
    const onKey = (_text: string | undefined, key: Key | undefined): void => {
      const name = key?.name;
      if ((key?.ctrl === true && name === "c") || name === "escape" || name === "q") {
        render(true);
        finish(null);
        return;
      }
      if (name === "up" || name === "k") move(-1);
      else if (name === "down" || name === "j") move(1);
      else if (name === "space" && enabled.includes(cursor)) selected[cursor] = !selected[cursor];
      else if (name === "a") {
        const all = enabled.every((index) => selected[index]);
        for (const index of enabled) selected[index] = !all;
      } else if (name === "return") {
        render(true);
        finish(choices.filter((_, index) => selected[index]).map((choice) => choice.value));
        return;
      }
      render(false);
    };

    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write("\x1b[?25l");
    input.on("keypress", onKey);
    render(false);
  });
}
