import { DomainError } from "../domain/errors.js";

export type ToolSuccess = { isError?: false; data: unknown };
export type ToolFailure = { isError: true; data: { error: string; message: string } };
export type ToolResult = ToolSuccess | ToolFailure;

export function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value;
}

export function toolOk(data: unknown): ToolSuccess {
  return { data };
}

export function toolErr(error: string, message: string): ToolFailure {
  return { isError: true, data: { error, message } };
}

export function fromCaught(error: unknown): ToolFailure {
  if (error instanceof DomainError) return toolErr(error.code, error.message);
  console.error(error);
  return toolErr("internal_error", "Internal error");
}

export function mcpContent(result: ToolResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result.data, jsonReplacer) }],
    isError: result.isError === true,
  };
}
