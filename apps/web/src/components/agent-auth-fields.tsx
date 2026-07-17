"use client";

import type { AgentAuthMethodDescriptor } from "@eveland/core/agent-auth";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export function AgentAuthFields({
  methods,
  method,
  values,
  onMethodChange,
  onValuesChange,
}: {
  methods: AgentAuthMethodDescriptor[];
  method: string;
  values: Record<string, string>;
  onMethodChange(method: string): void;
  onValuesChange(values: Record<string, string>): void;
}) {
  const descriptor = methods.find((candidate) => candidate.method === method);
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="agent-auth-method">Agent access method</FieldLabel>
        <Select
          value={method}
          onValueChange={(value) => {
            if (value) onMethodChange(value);
          }}
        >
          <SelectTrigger id="agent-auth-method" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {methods.map((candidate) => (
                <SelectItem key={candidate.method} value={candidate.method}>{candidate.label}</SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {descriptor ? <FieldDescription>{descriptor.description}</FieldDescription> : null}
      </Field>
      {descriptor?.fields.map((field) => {
        const id = `agent-auth-${method}-${field.key}`;
        const required = field.required && !field.secret;
        const value = values[field.key] ?? "";
        const onChange = (nextValue: string) => onValuesChange({ ...values, [field.key]: nextValue });
        return (
          <Field key={field.key}>
            <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
            {field.input === "textarea" ? (
              <Textarea
                id={id}
                rows={4}
                value={value}
                required={required}
                onChange={(event) => onChange(event.target.value)}
              />
            ) : (
              <Input
                id={id}
                value={value}
                required={required}
                type={field.input === "password" ? "password" : "text"}
                autoComplete={field.secret ? "new-password" : "off"}
                onChange={(event) => onChange(event.target.value)}
              />
            )}
            {field.secret ? <FieldDescription>Leave blank to keep the configured value.</FieldDescription> : null}
          </Field>
        );
      })}
    </FieldGroup>
  );
}
