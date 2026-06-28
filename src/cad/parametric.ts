import type { ParameterValue } from "./model";

type Token =
  | { type: "number"; value: number }
  | { type: "identifier"; value: string }
  | { type: "op"; value: "+" | "-" | "*" | "/" | "(" | ")" };

const LENGTH_UNITS: Record<string, number> = {
  mm: 1,
  millimeter: 1,
  millimeters: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  inch: 25.4,
  inches: 25.4
};

const ANGLE_UNITS: Record<string, number> = {
  deg: 1,
  degree: 1,
  degrees: 1,
  rad: 180 / Math.PI,
  radians: 180 / Math.PI
};

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[+\-*/()]/.test(ch)) {
      tokens.push({ type: "op", value: ch as Extract<Token, { type: "op" }>["value"] });
      i += 1;
      continue;
    }
    if (/\d|\./.test(ch)) {
      let raw = "";
      while (i < input.length && /[\d.]/.test(input[i])) {
        raw += input[i];
        i += 1;
      }
      let unit = "";
      while (i < input.length && /[a-zA-Z]/.test(input[i])) {
        unit += input[i];
        i += 1;
      }
      const unitKey = unit.toLowerCase();
      const scale = LENGTH_UNITS[unitKey] ?? ANGLE_UNITS[unitKey] ?? 1;
      tokens.push({ type: "number", value: Number(raw || "0") * scale });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let raw = "";
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) {
        raw += input[i];
        i += 1;
      }
      tokens.push({ type: "identifier", value: raw });
      continue;
    }
    throw new Error(`Unexpected character "${ch}"`);
  }
  return tokens;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly context: Record<string, number>
  ) {}

  parse() {
    const value = this.expression();
    if (this.peek()) {
      throw new Error("Unexpected trailing expression");
    }
    return value;
  }

  private expression(): number {
    let value = this.term();
    while (this.match("+") || this.match("-")) {
      const op = (this.previous() as Extract<Token, { type: "op" }>).value;
      const right = this.term();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  }

  private term(): number {
    let value = this.factor();
    while (this.match("*") || this.match("/")) {
      const op = (this.previous() as Extract<Token, { type: "op" }>).value;
      const right = this.factor();
      if (op === "/" && right === 0) {
        throw new Error("Division by zero");
      }
      value = op === "*" ? value * right : value / right;
    }
    return value;
  }

  private factor(): number {
    if (this.match("-")) {
      return -this.factor();
    }
    if (this.match("+")) {
      return this.factor();
    }
    const token = this.advance();
    if (!token) {
      throw new Error("Missing value");
    }
    if (token.type === "number") {
      return token.value;
    }
    if (token.type === "identifier") {
      if (!(token.value in this.context)) {
        throw new Error(`Unknown parameter "${token.value}"`);
      }
      return this.context[token.value];
    }
    if (token.type === "op" && token.value === "(") {
      const value = this.expression();
      if (!this.match(")")) {
        throw new Error("Missing closing parenthesis");
      }
      return value;
    }
    throw new Error("Unexpected token");
  }

  private match(value: Extract<Token, { type: "op" }>["value"]) {
    const token = this.peek();
    if (token?.type === "op" && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private advance() {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }

  private previous() {
    return this.tokens[this.index - 1];
  }

  private peek() {
    return this.tokens[this.index];
  }
}

export function evaluateExpression(expression: string, context: Record<string, number> = {}) {
  const parser = new Parser(tokenize(expression || "0"), context);
  const value = parser.parse();
  if (!Number.isFinite(value)) {
    throw new Error("Expression did not resolve to a finite value");
  }
  return value;
}

export function resolveParameters(parameters: Record<string, ParameterValue>) {
  const resolved: Record<string, number> = {};
  const resolving = new Set<string>();
  const warnings: string[] = [];

  const resolve = (name: string): number => {
    if (name in resolved) {
      return resolved[name];
    }
    const param = parameters[name];
    if (!param) {
      warnings.push(`Missing parameter "${name}"`);
      return 0;
    }
    if (resolving.has(name)) {
      warnings.push(`Circular parameter reference at "${name}"`);
      return 0;
    }
    resolving.add(name);
    const context = new Proxy(resolved, {
      has: (_, key) => typeof key === "string" && key in parameters,
      get: (_, key) => (typeof key === "string" ? resolve(key) : undefined)
    }) as Record<string, number>;
    try {
      resolved[name] = evaluateExpression(param.expression, context);
    } catch (error) {
      warnings.push(`${name}: ${error instanceof Error ? error.message : "Invalid expression"}`);
      resolved[name] = 0;
    } finally {
      resolving.delete(name);
    }
    return resolved[name];
  };

  Object.keys(parameters).forEach(resolve);
  return { values: resolved, warnings };
}
