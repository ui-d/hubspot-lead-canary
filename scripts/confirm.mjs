// Interactive guard for remote/destructive scripts. Requires typing "yes".

import { argv, exit, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

const action = argv[2] ?? "this action";
if (!stdin.isTTY) {
  console.error(`Refusing: "${action}" requires an interactive confirmation.`);
  exit(1);
}
const rl = createInterface({ input: stdin, output: stdout });
const answer = await rl.question(`${action}? Type "yes" to continue: `);
rl.close();
if (answer.trim() !== "yes") {
  console.error("Aborted.");
  exit(1);
}
