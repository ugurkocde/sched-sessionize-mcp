import { createInterface } from "node:readline";

/** Minimal prompt interface so setup logic can be tested without a terminal. */
export interface SetupIO {
  print(message: string): void;
  ask(question: string, defaultValue?: string): Promise<string>;
  /** Input is not echoed to the screen. */
  askSecret(question: string): Promise<string>;
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
}

export class NotInteractiveError extends Error {}
export class SetupCancelledError extends Error {}

function question(prompt: string, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let answered = false;
    // Ctrl+C / Ctrl+D close the prompt without an answer: report it instead of hanging.
    rl.on("SIGINT", () => rl.close());
    rl.on("close", () => {
      if (answered) return;
      process.stdout.write("\n");
      reject(new SetupCancelledError("Setup cancelled."));
    });
    if (hidden) {
      // Print the prompt, then mute everything the user types.
      const r = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
      r._writeToOutput = (s: string) => {
        if (s.includes(prompt)) r.output.write(prompt);
      };
    }
    rl.question(prompt, (answer) => {
      answered = true;
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

export function createTerminalIO(): SetupIO {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new NotInteractiveError(
      "Setup needs an interactive terminal. Run it directly in a terminal window, not through a pipe or an AI client.",
    );
  }
  return {
    print: (message) => process.stdout.write(message + "\n"),
    ask: async (q, def) => (await question(def ? `${q} [${def}]: ` : `${q}: `, false)) || def || "",
    askSecret: (q) => question(`${q}: `, true),
    confirm: async (q, def) => {
      const a = (await question(`${q} ${def ? "[Y/n]" : "[y/N]"}: `, false)).toLowerCase();
      if (!a) return def;
      return a === "y" || a === "yes" || a === "j" || a === "ja";
    },
  };
}
