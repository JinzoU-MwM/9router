"use client";

import { useId, useState } from "react";
import PropTypes from "prop-types";
import { Input, Button, ModelSelectModal } from "@/shared/components";

export const EMPTY_LIMITS_FORM = {
  allowedModels: [],
  rpm: "",
  tpm: "",
  tokenBudget: "",
  budgetPeriod: "lifetime",
  expiresAt: "",
};

/** Server `limits` (object or null) → form state. */
export function limitsToForm(limits) {
  if (!limits) return { ...EMPTY_LIMITS_FORM };
  return {
    allowedModels: limits.allowedModels || [],
    rpm: limits.rpm ?? "",
    tpm: limits.tpm ?? "",
    tokenBudget: limits.tokenBudget ?? "",
    budgetPeriod: limits.budgetPeriod || "lifetime",
    expiresAt: limits.expiresAt ? String(limits.expiresAt).slice(0, 10) : "",
  };
}

/** Form state → request body `limits`. Null when nothing is set. Server re-validates. */
export function formToLimits(form) {
  const num = (v) => (v === "" || v == null ? null : Number(v));
  const out = {
    allowedModels: form.allowedModels,
    rpm: num(form.rpm),
    tpm: num(form.tpm),
    tokenBudget: num(form.tokenBudget),
    budgetPeriod: form.budgetPeriod || "lifetime",
    expiresAt: form.expiresAt || null,
  };
  const empty = !out.allowedModels.length && out.rpm == null && out.tpm == null && out.tokenBudget == null && !out.expiresAt;
  return empty ? null : out;
}

const fieldClass = "w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-main disabled:opacity-50";
const modelValue = (m) => (typeof m === "string" ? m : m?.value || m?.name || "");

export default function KeyLimitsFields({ value, onChange, activeProviders = [], modelAliases = {} }) {
  const uid = useId();
  const [showPicker, setShowPicker] = useState(false);
  const [pattern, setPattern] = useState("");
  const set = (patch) => onChange({ ...value, ...patch });

  const addModel = (m) => {
    const v = modelValue(m).trim();
    if (v && !value.allowedModels.includes(v)) set({ allowedModels: [...value.allowedModels, v] });
  };
  const removeModel = (m) => {
    const v = modelValue(m);
    set({ allowedModels: value.allowedModels.filter((x) => x !== v) });
  };
  const addPattern = () => {
    addModel(pattern);
    setPattern("");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-text-main">Allowed models</label>
        {value.allowedModels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {value.allowedModels.map((m) => (
              <span key={m} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-primary/10 text-primary text-xs font-mono">
                {m}
                <button type="button" onClick={() => removeModel(m)} className="hover:text-red-500" aria-label={`Remove ${m}`}>
                  <span className="material-symbols-outlined text-[12px] leading-none">close</span>
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setShowPicker(true)} disabled={!activeProviders.length}>
            Select Model
          </Button>
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPattern(); } }}
            placeholder="openai/*"
            aria-label="Wildcard model pattern"
            className="flex-1 min-w-0 px-3 py-1 rounded-lg border border-border bg-surface text-sm font-mono"
          />
          <Button type="button" variant="ghost" size="sm" onClick={addPattern} disabled={!pattern.trim()}>
            Add
          </Button>
        </div>
        <p className="text-xs text-text-muted">
          Empty = all models. Use <code>*</code> as a wildcard, e.g. <code>openai/*</code>. Combos match by name.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Input label="RPM" type="number" min="0" value={value.rpm} onChange={(e) => set({ rpm: e.target.value })} placeholder="Unlimited" />
        <Input label="TPM" type="number" min="0" value={value.tpm} onChange={(e) => set({ tpm: e.target.value })} placeholder="Unlimited" />
        <Input label="Token budget" type="number" min="0" value={value.tokenBudget} onChange={(e) => set({ tokenBudget: e.target.value })} placeholder="Unlimited" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-period`} className="text-sm font-medium text-text-main">Budget period</label>
          <select id={`${uid}-period`} value={value.budgetPeriod} onChange={(e) => set({ budgetPeriod: e.target.value })} disabled={value.tokenBudget === ""} className={fieldClass}>
            <option value="lifetime">Lifetime</option>
            <option value="daily">Daily</option>
            <option value="monthly">Monthly</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-expires`} className="text-sm font-medium text-text-main">Expires</label>
          <input id={`${uid}-expires`} type="date" value={value.expiresAt} onChange={(e) => set({ expiresAt: e.target.value })} className={fieldClass} />
        </div>
      </div>

      <ModelSelectModal
        isOpen={showPicker}
        onClose={() => setShowPicker(false)}
        onSelect={addModel}
        onDeselect={removeModel}
        activeProviders={activeProviders}
        modelAliases={modelAliases}
        addedModelValues={value.allowedModels}
        closeOnSelect={false}
        title="Allowed models"
      />
    </div>
  );
}

KeyLimitsFields.propTypes = {
  value: PropTypes.shape({
    allowedModels: PropTypes.arrayOf(PropTypes.string).isRequired,
    rpm: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    tpm: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    tokenBudget: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
    budgetPeriod: PropTypes.string,
    expiresAt: PropTypes.string,
  }).isRequired,
  onChange: PropTypes.func.isRequired,
  activeProviders: PropTypes.array,
  modelAliases: PropTypes.object,
};
