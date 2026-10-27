import { useEffect, useRef, useState } from "react";

export function groupDigits(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function parseWhole(text: string): number | null {
  const digits = text.replace(/,/g, "").trim();
  if (!/^\d+$/u.test(digits)) return null;
  return Number(digits);
}

export function IntegerControl(props: {
  id: string;
  label: string;
  unit: string;
  value: number;
  onChange: (next: number) => void;
  sliderMin: number;
  sliderMax: number;
  sliderStep?: number;
  stepper?: number;
  hardMin: number;
  hardMax?: number;
  softNote?: string | null;
  trailing?: string;
  onValidity?: (ok: boolean) => void;
}) {
  const [text, setText] = useState(groupDigits(props.value));
  const [focused, setFocused] = useState(false);
  const validityRef = useRef(props.onValidity);
  validityRef.current = props.onValidity;
  const parsed = parseWhole(text);
  const rangeError = parsed === null
    ? "Enter a whole number. No decimals or negatives."
    : parsed < props.hardMin
      ? `Enter at least ${groupDigits(props.hardMin)}.`
      : props.hardMax !== undefined && parsed > props.hardMax
        ? `Enter ${groupDigits(props.hardMax)} or less.`
        : null;

  useEffect(() => {
    if (!focused) setText(groupDigits(props.value));
  }, [focused, props.value]);

  useEffect(() => {
    validityRef.current?.(rangeError === null);
  }, [rangeError]);

  const commit = (next: number) => {
    const capped = props.hardMax === undefined ? next : Math.min(props.hardMax, next);
    const bounded = Math.max(props.hardMin, capped);
    props.onChange(bounded);
    setText(groupDigits(bounded));
  };

  const sliderValue = Math.min(props.sliderMax, Math.max(props.sliderMin, props.value));

  return (
    <div className="p-3 rounded-2xl bg-white border border-slate-200 shadow-sm space-y-2">
      <label htmlFor={props.id} className="flex items-center justify-between gap-2 text-xs text-slate-700 font-medium">
        <span>{props.label}</span>
        <span className="font-mono text-slate-500">{props.unit}</span>
      </label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label={`Decrease ${props.label}`}
          className="min-h-11 min-w-11 rounded-xl border border-slate-300 bg-slate-50 text-lg font-semibold text-slate-800"
          onClick={() => commit(props.value - (props.stepper ?? props.sliderStep ?? 1))}
        >
          −
        </button>
        <input
          id={props.id}
          inputMode="numeric"
          aria-invalid={rangeError !== null}
          className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-base font-mono text-slate-900"
          value={focused ? text : groupDigits(props.value)}
          onFocus={() => {
            setFocused(true);
            setText(String(props.value));
          }}
          onBlur={() => {
            setFocused(false);
            if (parsed !== null && rangeError === null) commit(parsed);
            else setText(groupDigits(props.value));
          }}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            const whole = parseWhole(next);
            if (whole === null) return;
            if (whole < props.hardMin) return;
            if (props.hardMax !== undefined && whole > props.hardMax) return;
            props.onChange(whole);
          }}
        />
        <button
          type="button"
          aria-label={`Increase ${props.label}`}
          className="min-h-11 min-w-11 rounded-xl border border-slate-300 bg-slate-50 text-lg font-semibold text-slate-800"
          onClick={() => commit(props.value + (props.stepper ?? props.sliderStep ?? 1))}
        >
          +
        </button>
      </div>
      <input
        type="range"
        aria-label={`${props.label} slider`}
        min={props.sliderMin}
        max={props.sliderMax}
        step={props.sliderStep ?? 1}
        value={sliderValue}
        onChange={(event) => commit(Number(event.target.value))}
        className="h-11 w-full accent-emerald-800"
      />
      <div className="flex justify-between text-[11px] text-slate-500 font-mono">
        <span>{groupDigits(props.sliderMin)}</span>
        <span>{props.trailing ?? ""}</span>
        <span>{groupDigits(props.sliderMax)}</span>
      </div>
      {rangeError && <p className="text-xs text-red-700">{rangeError}</p>}
      {!rangeError && props.softNote && <p className="text-xs text-amber-800">{props.softNote}</p>}
    </div>
  );
}
