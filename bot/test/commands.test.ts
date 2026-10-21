import assert from "node:assert/strict";
import { test } from "node:test";
import { commandJson } from "../src/commands.js";

interface CommandOption {
  name: string;
  required?: boolean;
  options?: readonly CommandOption[];
}

test("registered commands put required options before optional options at every level", () => {
  function checkOptions(command: CommandOption, parent = ""): void {
    const commandPath = `${parent}/${command.name}`;
    let optionalSeen = false;
    for (const option of command.options ?? []) {
      if (option.required) {
        assert.equal(optionalSeen, false, `${commandPath}: required option ${option.name} follows an optional option`);
      } else {
        optionalSeen = true;
      }
      checkOptions(option, commandPath);
    }
  }

  for (const command of commandJson) checkOptions(command);
});
