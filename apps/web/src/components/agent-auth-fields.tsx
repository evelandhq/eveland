"use client";

import type { AgentAuthMethodDescriptor } from "@eveland/core/agent-auth";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
export { agentAuthValuesFromConfig, serializeAgentAuthConfig } from "@/lib/agent-auth-form";

export function AgentAuthFields({
  methods,
  method,
  values,
  onMethodChange,
  onValuesChange,
  allowBlankSecrets = false,
}: {
  methods: AgentAuthMethodDescriptor[];
  method: string;
  values: Record<string, string>;
  onMethodChange(method: string): void;
  onValuesChange(values: Record<string, string>): void;
  allowBlankSecrets?: boolean;
}) {
  const descriptor = methods.find((candidate) => candidate.method === method);
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`agent-auth-method-${method}`}>Agent access method</FieldLabel>
        <select
          id={`agent-auth-method-${method}`}
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={method}
          onChange={(event) => onMethodChange(event.target.value)}
        >
          {methods.map((candidate) => (
            <option key={candidate.method} value={candidate.method}>{candidate.label}</option>
          ))}
        </select>
        {descriptor ? <FieldDescription>{descriptor.description}</FieldDescription> : null}
      </Field>
      {descriptor?.fields.map((field) => {
        const id = `agent-auth-${method}-${field.key}`;
        const required = field.required && !(allowBlankSecrets && field.secret);
        const common = {
          id,
          value: values[field.key] ?? "",
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onValuesChange({
            ...values,
            [field.key]: event.target.value,
          }),
          required,
        };
        return (
          <Field key={field.key}>
            <FieldLabel htmlFor={id}>
              <span>
                {required ? <span aria-hidden className="mr-1 text-destructive">*</span> : null}
                {field.label}
              </span>
            </FieldLabel>
            {field.input === "textarea"
              ? <Textarea {...common} rows={4} />
              : <Input {...common} type={field.input === "password" ? "password" : "text"} autoComplete="off" />}
            {field.secret && allowBlankSecrets ? <FieldDescription>Leave blank to keep the configured value.</FieldDescription> : null}
          </Field>
        );
      })}
    </FieldGroup>
  );
}
