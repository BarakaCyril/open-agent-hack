import { useEffect, useRef, useState } from "react";
import { api, formatTraceLine, type RunCaseRequest, type RunCaseResponse, type TraceEvent } from "./api";
import { groupDigits, IntegerControl } from "./controls";

const STORAGE_KEY = "open-agent-maize.form";
const FARMER_ID = "demo-farmer";

function eventKey(event: TraceEvent): string {
  return `${event.timestamp}\t${event.agent_name}\t${event.action}\t${event.status}\t${event.output_summary}`;
}

function mergeEvents(current: TraceEvent[], incoming: TraceEvent[]): TraceEvent[] {
  const seen = new Set(current.map(eventKey));
  const next = current.slice();
  for (const event of incoming) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(event);
  }
  return next.length === current.length ? current : next;
}

type StorageType = RunCaseRequest["storage"];
type Lang = "en" | "sw";

interface CountyRow {
  county: string;
  coverage: "supported" | "limited";
  dry_maize_quotes_14d: number;
}

interface SavedForm {
  county: string;
  bags: number;
  storage: StorageType;
  hasOffer: boolean;
  offer: number;
  cashNeed: number;
  recheck: boolean;
}

const STORAGE_HELP: Record<StorageType, { en: string; sw: string }> = {
  open_bags: {
    en: "Bags kept in the open. Rain in the forecast can spoil the grain.",
    sw: "Magunia yako wazi. Mvua inaweza kuharibu mahindi.",
  },
  crib: {
    en: "A ventilated wooden crib. Air moves through, and rain can still reach the grain.",
    sw: "Ghala la mbao lenye upepo. Mvua bado inaweza kufika.",
  },
  hermetic: {
    en: "An airtight bag. The forecast changes the loss estimate much less.",
    sw: "Mfuko usiopitisha hewa. Mvua inaathiri hasara kidogo.",
  },
  dry_store: {
    en: "A dry store. Rain in the forecast is less of a problem than for open bags.",
    sw: "Ghala kavu. Mvua inaathiri kidogo kuliko magunia wazi.",
  },
};

function loadSaved(): Partial<SavedForm> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<SavedForm>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveForm(form: SavedForm) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
  } catch {
    // Private mode or a full disk should not block the form.
  }
}

function copy(lang: Lang) {
  if (lang === "sw") {
    return {
      profile: "Mkulima wa mfano",
      synthetic: "Demo farmer (synthetic data)",
      county: "Kaunti",
      bags: "Idadi ya magunia",
      bagsUnit: "magunia ya kilo 90",
      storage: "Aina ya hifadhi",
      offerToggle: "Nina ofa",
      offer: "Ofa ya mnunuzi",
      offerUnit: "KES kwa gunia la kilo 90",
      cash: "Pesa inayohitajika sasa",
      cashUnit: "KES",
      recheck: "Kagua tena ushauri wa awali",
      run: "Run Multi-Agent Deliberation",
      running: "Inaendesha…",
      retry: "Jaribu tena",
      median: "Wastani wa soko (P50)",
      loss: "Hatari ya hasara",
      advice: "Hii ni ushauri wa uamuzi, si ushauri wa kifedha. Haifanyi biashara.",
      trace: "Jinsi mawakala walivyofikia uamuzi",
      empty: "Bado hakuna jibu.",
      counties: "Kaunti hazijapatikana.",
    };
  }
  return {
    profile: "Farmer",
    synthetic: "Demo farmer (synthetic data)",
    county: "County",
    bags: "Bags of white maize",
    bagsUnit: "90 kg bags",
    storage: "Storage",
    offerToggle: "I have an offer",
    offer: "Buyer offer",
    offerUnit: "KES per 90 kg bag",
    cash: "Cash needed now",
    cashUnit: "KES",
    recheck: "Re-check my earlier advice",
    run: "Run Multi-Agent Deliberation",
    running: "Running…",
    retry: "Try again",
    median: "Market median (P50)",
    loss: "Loss risk",
    advice: "Decision support, not financial advice. This does not place a trade.",
    trace: "How the agents decided",
    empty: "No result yet.",
    counties: "Counties could not be loaded.",
  };
}

function verdictLabel(verdict: RunCaseResponse["verdict"], holdDays: number | null): string {
  if (verdict === "sell") return "Sell";
  if (verdict === "hold") return holdDays === null ? "Hold" : `Hold for ${holdDays} days`;
  if (verdict === "split") return "Split";
  return "No recommendation";
}

function sourceWords(source: RunCaseResponse["data_source"]): string {
  if (source === "zetaris") return "Zetaris";
  if (source === "mixed") return "Mixed";
  return "Sample";
}

function sourceDetail(source: RunCaseResponse["data_source"]): string {
  if (source === "zetaris") return "Prices, forecast and reference rows were read through Zetaris.";
  if (source === "mixed") return "Some reads came from Zetaris and some from the offline sample.";
  return "Zetaris was unreachable, so this run used the labelled offline sample.";
}

function kes(value: number): string {
  return `${groupDigits(Math.round(value))} KES`;
}

export function FarmerScreen(props: {
  lang: Lang;
  onActivity: (activity: { running: boolean; response: RunCaseResponse | null; events: TraceEvent[]; county: string }) => void;
}) {
  const saved = loadSaved();
  const text = copy(props.lang);
  const [counties, setCounties] = useState<CountyRow[]>([]);
  const [countyError, setCountyError] = useState<string | null>(null);
  const [county, setCounty] = useState(saved.county || "Kirinyaga");
  const [bags, setBags] = useState(saved.bags && saved.bags > 0 ? saved.bags : 20);
  const [bagsOk, setBagsOk] = useState(true);
  const [storage, setStorage] = useState<StorageType>(saved.storage || "open_bags");
  const [hasOffer, setHasOffer] = useState(saved.hasOffer === true);
  const [offer, setOffer] = useState(saved.offer && saved.offer > 0 ? saved.offer : 3400);
  const [offerOk, setOfferOk] = useState(true);
  const [cashNeed, setCashNeed] = useState(saved.cashNeed !== undefined && saved.cashNeed >= 0 ? saved.cashNeed : 20000);
  const [cashOk, setCashOk] = useState(true);
  const [recheck, setRecheck] = useState(saved.recheck === true);
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<RunCaseResponse | null>(null);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [traceError, setTraceError] = useState<string | null>(null);
  const activityRef = useRef(props.onActivity);
  const pollRef = useRef<number | null>(null);
  const stopStreamRef = useRef<(() => void) | null>(null);
  const liveLogRef = useRef<HTMLDivElement | null>(null);
  activityRef.current = props.onActivity;

  useEffect(() => () => {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    stopStreamRef.current?.();
  }, []);

  useEffect(() => {
    const log = liveLogRef.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
  }, [events]);

  useEffect(() => {
    let cancelled = false;
    api.counties()
      .then((body) => {
        if (cancelled) return;
        setCountyError(null);
        setCounties(body.counties);
        setCounty((current) => {
          const known = body.counties.some((row) => row.county === current);
          return known ? current : body.counties[0]?.county || current;
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setCountyError(err instanceof Error ? err.message : text.counties);
      });
    return () => {
      cancelled = true;
    };
  }, [text.counties]);

  useEffect(() => {
    saveForm({ county, bags, storage, hasOffer, offer, cashNeed, recheck });
  }, [county, bags, storage, hasOffer, offer, cashNeed, recheck]);

  useEffect(() => {
    activityRef.current({ running, response, events, county });
  }, [running, response, events, county]);

  const benchmark = response?.price_range_per_90kg_bag?.p50 ?? null;
  const offerMin = benchmark ? Math.max(50, Math.round(benchmark * 0.5)) : 1000;
  const offerMax = benchmark ? Math.max(offerMin + 50, Math.round(benchmark * 1.5)) : 8000;
  const formOk = bagsOk && cashOk && (!hasOffer || offerOk) && county.length > 0 && !countyError;

  const run = async () => {
    if (!formOk || running) return;
    setRunning(true);
    setError(null);
    setTraceError(null);
    setResponse(null);
    setEvents([]);
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    stopStreamRef.current?.();
    const payload: RunCaseRequest = {
      farmer_id: FARMER_ID,
      county,
      bags,
      storage,
      cash_need: cashNeed,
      mode: recheck ? "recheck" : "advise",
    };
    if (hasOffer) payload.offer_per_bag = offer;
    try {
      const started = await api.startRun(payload);
      const accept = (incoming: TraceEvent[]) => {
        setEvents((current) => mergeEvents(current, incoming));
      };
      const pull = async () => {
        try {
          const trace = await api.trace(started.trace_id);
          accept(trace.events);
        } catch {
          // The first poll can land before the trace file is registered.
        }
      };
      stopStreamRef.current = api.subscribeTraceEvents(started.trace_id, (event) => accept([event]), () => undefined);
      await pull();
      pollRef.current = window.setInterval(() => {
        void pull();
      }, 400);
      const body = await api.runResult(started.trace_id);
      setResponse(body);
      await pull();
    } catch (err: unknown) {
      setResponse(null);
      setEvents([]);
      setError(err instanceof Error ? err.message : "The run failed.");
    } finally {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
      pollRef.current = null;
      stopStreamRef.current?.();
      stopStreamRef.current = null;
      setRunning(false);
    }
  };

  const band = response?.price_range_per_90kg_bag ?? null;

  return (
    <div className="space-y-3.5">
      <div className="p-3 rounded-2xl bg-white border border-slate-200 shadow-sm">
        <div className="text-[10px] uppercase font-bold tracking-wider text-slate-400">{text.profile}</div>
        <div className="text-sm font-semibold text-slate-900">{text.synthetic}</div>
      </div>

      <div className="p-3 rounded-2xl bg-white border border-slate-200 shadow-sm space-y-1.5">
        <label htmlFor="county" className="text-xs font-medium text-slate-700">{text.county}</label>
        <select
          id="county"
          value={county}
          onChange={(event) => setCounty(event.target.value)}
          className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900"
        >
          {counties.map((row) => (
            <option key={row.county} value={row.county}>
              {row.county} · {row.coverage} · {row.dry_maize_quotes_14d} quotes
            </option>
          ))}
        </select>
        {countyError && <p className="text-xs text-red-700">{countyError}</p>}
      </div>

      <IntegerControl
        id="bags"
        label={text.bags}
        unit={text.bagsUnit}
        value={bags}
        onChange={setBags}
        sliderMin={5}
        sliderMax={100}
        sliderStep={5}
        stepper={1}
        hardMin={1}
        hardMax={500}
        trailing={`${groupDigits(bags * 90)} kg`}
        softNote={bags > 100 ? `The slider stops at 100. This run will use ${groupDigits(bags)} bags.` : null}
        onValidity={setBagsOk}
      />

      <div className="p-3 rounded-2xl bg-white border border-slate-200 shadow-sm space-y-1.5">
        <label htmlFor="storage" className="text-xs font-medium text-slate-700">{text.storage}</label>
        <select
          id="storage"
          value={storage}
          onChange={(event) => setStorage(event.target.value as StorageType)}
          className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900"
        >
          <option value="open_bags">Open bags</option>
          <option value="crib">Crib</option>
          <option value="hermetic">Hermetic bag</option>
          <option value="dry_store">Dry store</option>
        </select>
        <p className="text-xs text-slate-600">{STORAGE_HELP[storage][props.lang]}</p>
        <p className="text-xs text-slate-500">{text.loss}: —</p>
      </div>

      <div className="p-3 rounded-2xl bg-white border border-slate-200 shadow-sm space-y-2">
        <label className="flex min-h-11 items-center justify-between gap-3 text-sm text-slate-800">
          <span>{text.offerToggle}</span>
          <input
            type="checkbox"
            className="h-5 w-5 accent-emerald-800"
            checked={hasOffer}
            onChange={(event) => setHasOffer(event.target.checked)}
          />
        </label>
        {hasOffer && (
          <IntegerControl
            id="offer"
            label={text.offer}
            unit={text.offerUnit}
            value={offer}
            onChange={setOffer}
            sliderMin={offerMin}
            sliderMax={offerMax}
            sliderStep={50}
            stepper={50}
            hardMin={1}
            trailing={benchmark ? `${text.median}: ${kes(benchmark)}` : `${text.median}: —`}
            onValidity={setOfferOk}
          />
        )}
        {!hasOffer && <p className="text-xs text-slate-500">{text.median}: {benchmark ? kes(benchmark) : "—"}</p>}
      </div>

      <IntegerControl
        id="cash-need"
        label={text.cash}
        unit={text.cashUnit}
        value={cashNeed}
        onChange={setCashNeed}
        sliderMin={0}
        sliderMax={100000}
        sliderStep={1000}
        stepper={1000}
        hardMin={0}
        softNote={cashNeed > 100000 ? `The slider stops at 100,000. This run will use ${kes(cashNeed)}.` : null}
        onValidity={setCashOk}
      />
      <div className="flex flex-wrap gap-2">
        {[
          { label: "None", value: 0 },
          { label: "10,000", value: 10000 },
          { label: "20,000", value: 20000 },
          { label: "50,000", value: 50000 },
        ].map((chip) => (
          <button
            key={chip.label}
            type="button"
            className={`min-h-11 rounded-xl border px-3 text-sm ${cashNeed === chip.value ? "border-emerald-800 bg-emerald-50 text-emerald-900" : "border-slate-300 bg-white text-slate-800"}`}
            onClick={() => setCashNeed(chip.value)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <label className="flex min-h-11 items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-800">
        <span>{text.recheck}</span>
        <input
          type="checkbox"
          className="h-5 w-5 accent-emerald-800"
          checked={recheck}
          onChange={(event) => setRecheck(event.target.checked)}
        />
      </label>

      <button
        type="button"
        onClick={run}
        disabled={!formOk || running}
        className="min-h-11 w-full rounded-xl bg-emerald-800 px-3 text-sm font-bold text-white disabled:opacity-60"
      >
        {running ? text.running : text.run}
      </button>

      {error && (
        <div className="space-y-2 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <p>{error}</p>
          <button type="button" onClick={run} className="min-h-11 rounded-xl border border-red-300 bg-white px-3 text-sm font-semibold text-red-900">
            {text.retry}
          </button>
        </div>
      )}

      {running && (
        <div ref={liveLogRef} className="max-h-40 space-y-1 overflow-y-auto rounded-xl bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-100">
          {events.length === 0 ? <p className="text-slate-400">Waiting for the first trace line…</p> : events.map((event, index) => (
            <p key={`${event.timestamp}-${event.action}-${index}`}>{formatTraceLine(event)}</p>
          ))}
        </div>
      )}

      {!response && !error && !running && (
        <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-600 space-y-1">
          <p>{text.empty}</p>
          <p>{text.median}: —</p>
          <p>{text.loss}: —</p>
          <p>Confidence: —</p>
        </div>
      )}

      {response && !error && <ResultCard response={response} events={events} traceError={traceError} text={text} />}
    </div>
  );
}

function ResultCard(props: {
  response: RunCaseResponse;
  events: TraceEvent[];
  traceError: string | null;
  text: ReturnType<typeof copy>;
}) {
  const { response, events, traceError, text } = props;
  const band = response.price_range_per_90kg_bag;
  const fallback = response.limitations.find((line) => /refresh_unavailable|fell back|offline mode|wording fell back/i.test(line));
  return (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-slate-300 bg-slate-50 px-2 py-1 text-xs font-semibold">
          {sourceWords(response.data_source)}
        </span>
        <span className="text-xs text-slate-600">Confidence {Math.round(response.confidence * 100)}%</span>
      </div>
      <p className="text-xs text-slate-600">{sourceDetail(response.data_source)}</p>
      {fallback && <p className="text-xs text-amber-900">{fallback}</p>}
      <h3 className="text-xl font-bold text-slate-900">{verdictLabel(response.verdict, response.hold_days)}</h3>
      {response.verdict === "no_recommendation" && (
        <div className="space-y-1 text-sm">
          {response.reason && <p>{response.reason}</p>}
          {response.question_for_farmer && <p className="font-medium">{response.question_for_farmer}</p>}
        </div>
      )}
      <p>{response.plain_reply}</p>
      <dl className="space-y-1 text-xs">
        <div className="flex justify-between gap-3"><dt>P10</dt><dd className="font-mono">{band ? kes(band.p10) : "—"}</dd></div>
        <div className="flex justify-between gap-3"><dt>{text.median}</dt><dd className="font-mono">{band ? kes(band.p50) : "—"}</dd></div>
        <div className="flex justify-between gap-3"><dt>P90</dt><dd className="font-mono">{band ? kes(band.p90) : "—"}</dd></div>
        <div className="flex justify-between gap-3"><dt>{text.loss}</dt><dd>—</dd></div>
        <div className="flex justify-between gap-3"><dt>Hold days</dt><dd className="font-mono">{response.hold_days ?? "—"}</dd></div>
        <div className="flex justify-between gap-3"><dt>Provider</dt><dd className="font-mono">{response.provider}</dd></div>
        <div className="flex justify-between gap-3"><dt>Model</dt><dd className="font-mono text-right">{response.model}</dd></div>
        <div className="flex justify-between gap-3"><dt>Trace</dt><dd className="font-mono">{response.trace_id.slice(0, 8)}</dd></div>
      </dl>
      <p className="text-xs text-slate-600">{response.recheck_schedule}</p>
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500">Evidence</h4>
        <ul className="mt-1 space-y-1 text-xs">
          {response.evidence.length === 0 && <li>—</li>}
          {response.evidence.map((item, index) => (
            <li key={`${item.source}-${item.as_of}-${index}`}>
              {item.source} · {item.as_of} · {item.freshness}{item.synthetic ? " · synthetic" : ""}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500">What would change this advice</h4>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
          {response.what_would_change_this_advice.length === 0 && <li>—</li>}
          {response.what_would_change_this_advice.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500">Limitations</h4>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
          {response.limitations.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </div>
      <p className="text-xs text-slate-600">{text.advice}</p>
      <details className="rounded-xl border border-slate-200 bg-slate-50 p-2">
        <summary className="min-h-11 cursor-pointer text-sm font-semibold">{text.trace}</summary>
        <div className="mt-2 max-h-64 space-y-1 overflow-y-auto font-mono text-[11px] text-slate-800">
          {traceError && <p>{traceError}</p>}
          {events.length === 0 && !traceError && <p>No trace events were returned.</p>}
          {events.map((event, index) => (
            <p key={`${event.timestamp}-${event.action}-${index}`}>{formatTraceLine(event)}</p>
          ))}
        </div>
      </details>
    </div>
  );
}
