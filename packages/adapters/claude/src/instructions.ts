import type { InstructionPolicy } from "@statecase/adapter-common/instructions";
export const claudeInstructionPolicy: InstructionPolicy = { files: ["CLAUDE.md"], trees: ["rules", "instructions"], imports: true };
