"use client";

import type {
  AgentAuthMethodDescriptor,
  AgentAuthSecretReference,
} from "@evelandhq/core/agent-auth";
import type { AgentAuthSecretReferenceOption } from "@/lib/client-api";
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
  secretReferences,
  referenceValues,
  onMethodChange,
  onValuesChange,
  onReferenceValuesChange,
}: {
  methods: AgentAuthMethodDescriptor[];
  method: string;
  values: Record<string, string>;
  secretReferences: AgentAuthSecretReferenceOption[];
  referenceValues: Record<string, AgentAuthSecretReference | null>;
  onMethodChange(method: string): void;
  onValuesChange(values: Record<string, string>): void;
  onReferenceValuesChange(values: Record<string, AgentAuthSecretReference | null>): void;
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
                <SelectItem key={candidate.method} value={candidate.method}>
                  {candidate.label}
                </SelectItem>
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
        const onChange = (nextValue: string) =>
          onValuesChange({ ...values, [field.key]: nextValue });
        if (field.secretReferenceKey) {
          const referenceKey = field.secretReferenceKey;
          const items = [
            { label: "Keep the configured reference", value: null },
            ...secretReferences.map((reference) => ({
              label: reference.revision
                ? `${reference.label} · r${reference.revision}`
                : reference.label,
              value: `${reference.kind}:${reference.key}`,
            })),
          ];
          const selected = referenceValues[referenceKey];
          const selectedValue = selected ? `${selected.kind}:${selected.key}` : null;
          return (
            <Field key={field.key}>
              <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
              <Select
                items={items}
                value={selectedValue}
                onValueChange={(nextValue) => {
                  const reference = secretReferences.find(
                    (candidate) => `${candidate.kind}:${candidate.key}` === nextValue,
                  );
                  onReferenceValuesChange({
                    ...referenceValues,
                    [referenceKey]: reference ? { kind: reference.kind, key: reference.key } : null,
                  });
                }}
              >
                <SelectTrigger id={id} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {items.map((item) => (
                      <SelectItem key={item.value ?? "configured"} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                {secretReferences.length > 0
                  ? "Select a current Project Secret or available connection credential reference. Leave unchanged to preserve the existing reference."
                  : "Add a Project Secret before configuring this method."}
              </FieldDescription>
            </Field>
          );
        }
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
            ) : field.input === "select" ? (
              <Select value={value} onValueChange={(nextValue) => nextValue && onChange(nextValue)}>
                <SelectTrigger id={id} className="w-full">
                  <SelectValue placeholder={`Select ${field.label.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectGroup>
                    {field.options?.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
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
            {field.secret ? (
              <FieldDescription>Leave blank to keep the configured value.</FieldDescription>
            ) : null}
          </Field>
        );
      })}
    </FieldGroup>
  );
}
