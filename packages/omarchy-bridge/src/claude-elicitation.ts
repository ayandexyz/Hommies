/** Maps Claude Code MCP form elicitations onto Hommies' question contract. */

type Json = Readonly<Record<string, unknown>>;
type Scalar = string | number | boolean;
type FieldKind = "string" | "number" | "integer" | "boolean";

interface ElicitationField {
  readonly key: string;
  readonly question: string;
  readonly kind: FieldKind;
  readonly values?: ReadonlyArray<Scalar>;
}

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const scalar = (value: unknown): value is Scalar =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

function requestId(input: Json): string | null {
  const server = string(input.mcp_server_name);
  if (server === undefined) return null;
  return `elicitation:${string(input.elicitation_id) ?? server}`;
}

function fields(input: Json): ElicitationField[] {
  if (input.mode !== undefined && input.mode !== "form") return [];
  if (!isObject(input.requested_schema) || !isObject(input.requested_schema.properties)) return [];
  const required = new Set(Array.isArray(input.requested_schema.required)
    ? input.requested_schema.required.filter((value): value is string => typeof value === "string")
    : []);
  if (required.size === 0) return [];
  const message = string(input.message) ?? "An MCP server needs your input";
  const supported = Object.entries(input.requested_schema.properties).flatMap(([key, raw]): ElicitationField[] => {
    if (!required.has(key) || !isObject(raw)) return [];
    const values = Array.isArray(raw.enum) && raw.enum.length > 0 && raw.enum.every(scalar) ? raw.enum : undefined;
    const inferred = typeof values?.[0];
    const kind = raw.type === "integer" || raw.type === "number" || raw.type === "boolean" || raw.type === "string"
      ? raw.type
      : inferred === "number" ? "number" : inferred === "boolean" ? "boolean" : inferred === "string" ? "string" : null;
    if (kind === null) return [];
    const label = string(raw.description) ?? string(raw.title) ?? key;
    return [{ key, question: `${message}\n${label}`, kind, ...(values === undefined ? {} : { values }) }];
  });
  // A partial accept would violate the MCP server's schema. Leave the entire
  // form in Claude's native dialog when any required field is unsupported.
  return supported.length === required.size ? supported : [];
}

/** A supported form elicitation as a synthetic AskUserQuestion request. */
export function claudeElicitationQuestion(input: unknown): Record<string, unknown> | null {
  if (!isObject(input) || input.hook_event_name !== "Elicitation") return null;
  const session = string(input.session_id);
  const id = requestId(input);
  const formFields = fields(input);
  if (session === undefined || id === null || formFields.length === 0) return null;
  return {
    session_id: session,
    ...(string(input.cwd) === undefined ? {} : { cwd: string(input.cwd) }),
    ...(string(input.transcript_path) === undefined ? {} : { transcript_path: string(input.transcript_path) }),
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: id,
    tool_input: {
      questions: formFields.map((field) => ({
        id: field.key,
        header: field.key,
        question: field.question,
        options: (field.values ?? (field.kind === "boolean" ? [true, false] : [])).map((value) => ({
          label: field.kind === "boolean" ? value === true ? "Yes" : "No" : String(value),
        })),
        multiSelect: false,
      })),
    },
  };
}

/** Converts Hommies' question answer into Claude Code's Elicitation decision. */
export function claudeElicitationReply(input: unknown, reply: unknown): Record<string, unknown> | null {
  if (!isObject(input) || !isObject(reply) || !isObject(reply.hookSpecificOutput)) return null;
  const output = reply.hookSpecificOutput;
  if (!isObject(output.updatedInput) || !isObject(output.updatedInput.answers)) return null;
  const formFields = fields(input);
  if (formFields.length === 0) return null;
  const content: Record<string, Scalar> = {};
  for (const field of formFields) {
    const answer = output.updatedInput.answers[field.key];
    if (typeof answer !== "string") return null;
    if (field.values !== undefined) {
      const selected = field.values.find((value) =>
        (field.kind === "boolean" ? value === true ? "Yes" : "No" : String(value)) === answer);
      if (selected === undefined) return null;
      content[field.key] = selected;
    } else if (field.kind === "boolean") {
      if (answer !== "Yes" && answer !== "No") return null;
      content[field.key] = answer === "Yes";
    } else if (field.kind === "number" || field.kind === "integer") {
      const number = Number(answer);
      if (!Number.isFinite(number) || (field.kind === "integer" && !Number.isInteger(number))) return null;
      content[field.key] = number;
    } else {
      content[field.key] = answer;
    }
  }
  return { hookSpecificOutput: { hookEventName: "Elicitation", action: "accept", content } };
}

/** An ElicitationResult as a synthetic AskUserQuestion resolution. */
export function claudeElicitationResolved(input: unknown): Record<string, unknown> | null {
  if (!isObject(input) || input.hook_event_name !== "ElicitationResult") return null;
  const session = string(input.session_id);
  const id = requestId(input);
  if (session === undefined || id === null) return null;
  return {
    session_id: session,
    ...(string(input.cwd) === undefined ? {} : { cwd: string(input.cwd) }),
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: id,
    tool_input: {},
  };
}
