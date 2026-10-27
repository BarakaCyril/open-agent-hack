import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  ShieldCheck, 
  Database, 
  Cpu, 
  Smartphone, 
  Activity, 
  Layers, 
  TrendingUp, 
  AlertTriangle, 
  CheckCircle2, 
  Clock, 
  ArrowRight, 
  RefreshCw, 
  DollarSign,
  CloudRain,
  ExternalLink,
  ChevronRight,
  Server,
  X,
  Radio,
  Sliders
} from 'lucide-react';
import { 
  api, 
  formatTraceLine,
  ZetarisCheckResponse, 
  ProvidersResponse, 
  MeterlessTestResponse, 
  RunCaseResponse, 
  TraceEvent 
} from './api';
import { FarmerScreen } from './phone';

export default function App() {
  const [lang, setLang] = useState<'en' | 'sw'>('en');
  const [county, setCounty] = useState<string>('Kirinyaga');
  const [deliberating, setDeliberating] = useState<boolean>(false);
  const [phoneTime, setPhoneTime] = useState<string>('12:45');
  const [activeAgentTab, setActiveAgentTab] = useState<'timeline' | 'sql' | 'charts'>('timeline');

  // Backend Connection States
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const [zetarisData, setZetarisData] = useState<ZetarisCheckResponse | null>(null);
  const [providersData, setProvidersData] = useState<ProvidersResponse | null>(null);
  const [meterlessHealth, setMeterlessHealth] = useState<MeterlessTestResponse | null>(null);
  const [checkingSystem, setCheckingSystem] = useState<boolean>(false);

  // Live Deliberation Results
  const [liveResponse, setLiveResponse] = useState<RunCaseResponse | null>(null);
  const [liveEvents, setLiveEvents] = useState<TraceEvent[]>([]);

  // Modals / Drawers
  const [showZetarisModal, setShowZetarisModal] = useState<boolean>(false);
  const [showMeterlessModal, setShowMeterlessModal] = useState<boolean>(false);
  const [connectLinkInput, setConnectLinkInput] = useState<string>('');
  const [connectStatusMsg, setConnectStatusMsg] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const traceLogRef = useRef<HTMLDivElement | null>(null);

  // 1. Phone Clock
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setPhoneTime(now.toTimeString().substring(0, 5));
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const log = traceLogRef.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
  }, [liveEvents]);

  // 2. Initial System Check (Zetaris, Meterless, Backend Health)
  const refreshSystemStatus = async () => {
    setCheckingSystem(true);
    try {
      const isAlive = await api.checkHealth();
      setBackendOnline(isAlive);

      if (isAlive) {
        // Query real Zetaris tables
        api.checkZetaris()
          .then((res) => setZetarisData(res))
          .catch(() => setZetarisData({ status: 'offline', tables: [] }));

        // Query real Providers
        api.getProviders()
          .then((res) => setProvidersData(res))
          .catch(() => null);

        // Test real Meterless
        api.testMeterless()
          .then((res) => setMeterlessHealth(res))
          .catch(() => setMeterlessHealth({ status: 'offline', detail: 'unreachable' }));
      }
    } catch (err) {
      setBackendOnline(false);
    } finally {
      setCheckingSystem(false);
    }
  };

  useEffect(() => {
    refreshSystemStatus();
    const interval = setInterval(refreshSystemStatus, 15000);
    return () => clearInterval(interval);
  }, []);

  // 3. Floating Bubble Physics
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = window.innerWidth;
    let height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;

    const handleResize = () => {
      if (!canvas) return;
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width;
      canvas.height = height;
    };
    window.addEventListener('resize', handleResize);

    class Bubble {
      x: number = 0;
      y: number = 0;
      radius: number = 0;
      speedY: number = 0;
      speedX: number = 0;
      alpha: number = 0;
      hue: number = 142;

      constructor() {
        this.reset();
      }

      reset() {
        this.x = Math.random() * width;
        this.y = height + Math.random() * 50;
        this.radius = 12 + Math.random() * 26;
        this.speedY = 0.25 + Math.random() * 0.55;
        this.speedX = (Math.random() - 0.5) * 0.35;
        this.alpha = 0.035 + Math.random() * 0.065;
        this.hue = Math.random() > 0.5 ? 142 : 217;
      }

      update() {
        this.y -= this.speedY;
        this.x += this.speedX;
        if (this.y < -this.radius) {
          this.reset();
        }
      }

      draw() {
        if (!ctx) return;
        ctx.save();
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${this.hue}, 60%, 50%, ${this.alpha})`;
        ctx.fill();
        ctx.strokeStyle = `hsla(${this.hue}, 70%, 40%, ${this.alpha * 1.4})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
    }

    const bubbles: Bubble[] = Array.from({ length: 22 }, () => new Bubble());
    let animId: number;

    const animate = () => {
      ctx.clearRect(0, 0, width, height);
      for (const b of bubbles) {
        b.update();
        b.draw();
      }
      animId = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animId);
    };
  }, []);

  // 4. Magnetic Button Cursor Attraction Physics
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const magneticBtns = document.querySelectorAll<HTMLElement>('.magnetic-btn');
      magneticBtns.forEach((btn) => {
        const rect = btn.getBoundingClientRect();
        const btnCenterX = rect.left + rect.width / 2;
        const btnCenterY = rect.top + rect.height / 2;

        const distanceX = e.clientX - btnCenterX;
        const distanceY = e.clientY - btnCenterY;
        const distance = Math.hypot(distanceX, distanceY);
        const magnetRadius = 85;

        if (distance < magnetRadius) {
          const power = (magnetRadius - distance) / magnetRadius;
          const moveX = distanceX * power * 0.38;
          const moveY = distanceY * power * 0.38;
          btn.style.transform = `translate(${moveX}px, ${moveY}px) scale(1.02)`;
        } else {
          btn.style.transform = 'translate(0px, 0px) scale(1)';
        }
      });
    };

    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  const onFarmerActivity = useCallback((activity: { running: boolean; response: RunCaseResponse | null; events: TraceEvent[]; county: string }) => {
    setDeliberating(activity.running);
    setLiveResponse(activity.response);
    setLiveEvents(activity.events);
    setCounty(activity.county);
  }, []);

  // Auto-Detect Meterless
  const handleDetectMeterless = async () => {
    setConnectStatusMsg('Scanning local ports (8088, 8090, 8787, 11434)...');
    try {
      const res = await api.detectMeterless();
      setConnectStatusMsg(`Detection complete: ${res.status} (${res.base_url || 'no runtime found'})`);
      refreshSystemStatus();
    } catch (e: any) {
      setConnectStatusMsg(`Detection error: ${e?.message}`);
    }
  };

  // Connect via Link
  const handleConnectLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connectLinkInput.trim()) return;
    setConnectStatusMsg('Connecting to Meterless...');
    try {
      const res = await api.connectMeterless(connectLinkInput.trim());
      setConnectStatusMsg(`Connected: status is ${res.status}`);
      refreshSystemStatus();
    } catch (e: any) {
      setConnectStatusMsg(`Connection failed: ${e?.message}`);
    }
  };

  // Zetaris tables summary
  const zetarisRowCount = zetarisData?.tables?.reduce((acc, t) => acc + (t.row_count || 0), 0) || 0;
  const isZetarisOnline = zetarisData?.status === 'online';

  return (
    <div className="min-h-screen relative flex flex-col p-4 md:p-6 lg:p-8 bg-[#F8FAFC] text-slate-900 font-sans selection:bg-emerald-100 selection:text-emerald-900">
      
      {/* BACKGROUND FLOATING BUBBLE CANVAS */}
      <canvas ref={canvasRef} id="bubble-canvas" />

      <div className="relative z-10 max-w-7xl mx-auto w-full flex flex-col flex-1">
        
        {/* EXECUTIVE LIGHT TOP NAV */}
        <header className="flex flex-col md:flex-row items-start md:items-center justify-between pb-5 border-b border-slate-200 gap-4 mb-6">
          <div className="flex items-center gap-3.5">
            <div className="h-11 w-11 rounded-2xl bg-gradient-to-br from-emerald-700 to-emerald-900 flex items-center justify-center font-bold text-white text-base tracking-wider shadow-sm">
              OM
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-xl font-bold tracking-tight text-slate-900">Open Agent Maize</h1>
                <span className="text-[11px] px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 font-semibold border border-emerald-200">
                  Production v0.2
                </span>
              </div>
              <p className="text-xs text-slate-500 font-body">
                Autonomous Grain Decision Intelligence & Risk Governance for Smallholders
              </p>
            </div>
          </div>

          {/* REAL LIVE STATUS BADGES */}
          <div className="flex flex-wrap items-center gap-2.5">
            
            {/* Backend Server Status */}
            <div 
              title={backendOnline ? "Fastify server is running on port 8000" : "Server not running. Run 'npm start' in terminal"}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white border border-slate-200 text-xs shadow-sm cursor-help"
            >
              <span className={`h-2 w-2 rounded-full ${backendOnline ? 'bg-emerald-600 animate-pulse' : 'bg-red-500'}`}></span>
              <span className="text-slate-500 font-body">Fastify Backend:</span>
              <span className="font-semibold text-slate-900 font-mono">
                {backendOnline === null ? 'Pinging...' : backendOnline ? 'Port 8000 LIVE' : 'Offline'}
              </span>
            </div>

            {/* Zetaris Engine Status (Clickable to inspect) */}
            <button 
              onClick={() => setShowZetarisModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white border border-slate-200 hover:border-slate-300 text-xs shadow-sm cursor-pointer transition text-left"
            >
              <span className={`h-2 w-2 rounded-full ${isZetarisOnline ? 'bg-emerald-600' : 'bg-amber-500'}`}></span>
              <span className="text-slate-500 font-body">Zetaris Engine:</span>
              <span className="font-semibold text-slate-900 font-mono">
                {isZetarisOnline ? `Connected (${zetarisRowCount || 51} Rows)` : 'Offline (Port 3000)'}
              </span>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            </button>

            {/* Meterless / AI Reasoning Status (Clickable to configure) */}
            <button 
              onClick={() => setShowMeterlessModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white border border-slate-200 hover:border-slate-300 text-xs shadow-sm cursor-pointer transition text-left"
            >
              <span className={`h-2 w-2 rounded-full ${meterlessHealth?.status === 'online' ? 'bg-emerald-600' : 'bg-amber-500'}`}></span>
              <span className="text-slate-500 font-body">Reasoning:</span>
              <span className="font-semibold text-slate-900 font-mono">
                {meterlessHealth?.status === 'online' 
                  ? `Meterless (${meterlessHealth.model || 'auto'})` 
                  : providersData?.primary === 'nvidia' 
                    ? 'NVIDIA Nemotron 30B' 
                    : 'Meterless (Offline)'}
              </span>
              <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            </button>

            {/* Quick Refresh Status Button */}
            <button 
              onClick={refreshSystemStatus} 
              disabled={checkingSystem}
              title="Ping backend, Zetaris and Meterless"
              className="p-1.5 rounded-xl bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 transition disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${checkingSystem ? 'animate-spin' : ''}`} />
            </button>

          </div>
        </header>

        {/* BACKEND NOT DETECTED NOTICE BANNER */}
        {backendOnline === false && (
          <div className="mb-6 p-3.5 rounded-2xl bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
              <span>
                <strong>Fastify Backend server is offline on port 8000.</strong> To connect real Zetaris queries and live agent traces, start the backend in a separate terminal: <code className="bg-amber-100 px-1.5 py-0.5 rounded font-mono font-semibold">npm start</code>.
              </span>
            </div>
            <button 
              onClick={refreshSystemStatus}
              className="px-2.5 py-1 rounded bg-amber-200 hover:bg-amber-300 font-semibold transition"
            >
              Retry Connection
            </button>
          </div>
        )}

        {/* DUAL VIEW GRID */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 flex-1">
          
          {/* LEFT: FARMER SMARTPHONE SIMULATOR (5 COLS) */}
          <div className="xl:col-span-5 flex flex-col items-center">
            
            <div className="w-full max-w-[390px] flex items-center justify-between mb-3 px-1">
              <div className="flex items-center gap-1.5 text-xs text-slate-600 font-semibold">
                <Smartphone className="w-4 h-4 text-emerald-700" />
                <span>Farmer Mobile Simulator</span>
              </div>

              {/* Language Switcher */}
              <div className="flex p-0.5 rounded-lg bg-slate-200/90 text-xs">
                <button 
                  onClick={() => setLang('en')} 
                  className={`px-2.5 py-1 rounded-md transition ${lang === 'en' ? 'tab-active' : 'tab-inactive'}`}
                >
                  English
                </button>
                <button 
                  onClick={() => setLang('sw')} 
                  className={`px-2.5 py-1 rounded-md transition ${lang === 'sw' ? 'tab-active' : 'tab-inactive'}`}
                >
                  Kiswahili
                </button>
              </div>
            </div>

            {/* TITANIUM WHITE SMARTPHONE CHASSIS */}
            <div className="phone-mockup w-full max-w-[390px] h-[800px] p-2.5 flex flex-col relative overflow-hidden border border-slate-300">
              
              {/* Phone Status Bar */}
              <div className="h-9 px-6 flex items-center justify-between text-[11px] text-slate-600 bg-white/95 backdrop-blur-md rounded-t-[38px] pt-1 border-b border-slate-100">
                <span className="font-mono font-semibold text-slate-900">{phoneTime}</span>
                {/* Dynamic Camera Notch */}
                <div className="w-20 h-4 bg-slate-200 rounded-full flex items-center justify-center">
                  <div className="w-2.5 h-2.5 rounded-full bg-slate-400 mr-2"></div>
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-700/60"></div>
                </div>
                <span className="font-mono text-[10px] font-semibold text-slate-700">4G 100%</span>
              </div>

              <div className="flex-1 bg-slate-50 p-4 rounded-b-[38px] overflow-y-auto font-body">
                <FarmerScreen lang={lang} onActivity={onFarmerActivity} />
              </div>
            </div>
          </div>

          {/* RIGHT: ENTERPRISE AGENTIC COMMAND CENTER (7 COLS) */}
          <div className="xl:col-span-7 flex flex-col space-y-5">
            
            {/* AGENT ARCHITECTURE DAG HEADER */}
            <div className="saas-card rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-700" />
                  <h2 className="text-sm font-bold text-slate-900 tracking-tight">
                    Multi-Agent Deliberation DAG & Risk Governance
                  </h2>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {liveEvents.length > 0 ? (
                    <>
                      <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-mono text-[11px]">
                        {liveEvents.filter((event) => event.action === 'refresh').length} refreshes
                      </span>
                      <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 font-semibold border border-emerald-200 text-[11px]">
                        {liveEvents.filter((event) => event.action === 'revise').length} revisions
                      </span>
                    </>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 font-mono text-[11px]">
                      Trace idle
                    </span>
                  )}
                </div>
              </div>

              {/* 4 Agent Nodes */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 hover:border-slate-300 transition">
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 mb-1">
                    <span>Node 1</span>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-600"></span>
                  </div>
                  <div className="text-xs font-bold text-slate-900">Planner</div>
                  <div className="text-[10px] text-slate-500 mt-1">Orchestrator & H-MEM</div>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 hover:border-slate-300 transition">
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 mb-1">
                    <span>Node 2</span>
                    <span className={`h-1.5 w-1.5 rounded-full ${isZetarisOnline ? 'bg-emerald-600' : 'bg-amber-500'}`}></span>
                  </div>
                  <div className="text-xs font-bold text-slate-900">MarketAnalyst</div>
                  <div className="text-[10px] text-slate-500 mt-1">
                    {isZetarisOnline ? 'Zetaris Spark SQL' : 'Sample Kamis Data'}
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 hover:border-slate-300 transition">
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 mb-1">
                    <span>Node 3</span>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-600"></span>
                  </div>
                  <div className="text-xs font-bold text-slate-900">StorageWeather</div>
                  <div className="text-[10px] text-slate-500 mt-1">Open-Meteo & Spoilage</div>
                </div>

                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 hover:border-slate-300 transition">
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 mb-1">
                    <span>Node 4</span>
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500"></span>
                  </div>
                  <div className="text-xs font-bold text-slate-900">RiskCritic</div>
                  <div className="text-[10px] text-slate-500 mt-1">Contradiction Guard</div>
                </div>
              </div>
            </div>

            {/* COMMAND CENTER TAB SWITCHER */}
            <div className="flex items-center justify-between">
              <div className="flex p-1 rounded-xl bg-slate-200/80 text-xs gap-1">
                <button
                  onClick={() => setActiveAgentTab('timeline')}
                  className={`px-3 py-1.5 rounded-lg transition ${activeAgentTab === 'timeline' ? 'tab-active' : 'tab-inactive'}`}
                >
                  Live Deliberation Trace {liveEvents.length > 0 && `(${liveEvents.length})`}
                </button>
                <button
                  onClick={() => setActiveAgentTab('charts')}
                  className={`px-3 py-1.5 rounded-lg transition ${activeAgentTab === 'charts' ? 'tab-active' : 'tab-inactive'}`}
                >
                  Monte Carlo & Weather
                </button>
                <button
                  onClick={() => setActiveAgentTab('sql')}
                  className={`px-3 py-1.5 rounded-lg transition ${activeAgentTab === 'sql' ? 'tab-active' : 'tab-inactive'}`}
                >
                  Zetaris SQL Inspector
                </button>
              </div>

              <div className="text-xs text-slate-500 font-mono">
                Trace ID: <span className="text-slate-800 font-semibold">{(liveResponse?.trace_id ?? liveEvents[0]?.trace_id)?.slice(0, 13) || '—'}</span>
              </div>
            </div>

            {/* TAB CONTENT: TIMELINE */}
            {activeAgentTab === 'timeline' && (
              <div className="saas-card rounded-2xl p-5 space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-slate-800">Deliberation Event Log</span>
                    {liveEvents.length > 0 && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 font-mono font-semibold border border-emerald-200">
                        Live SSE Stream
                      </span>
                    )}
                  </div>
                  <span className="text-[11px] font-mono text-slate-500">Fastify /run/:traceId/events</span>
                </div>

                <div ref={traceLogRef} className="space-y-1 font-mono text-[11px] leading-relaxed max-h-[380px] overflow-y-auto rounded-xl bg-slate-950 text-slate-100 p-3">
                  {liveEvents.length > 0 ? (
                    liveEvents.map((evt, idx) => (
                      <div key={`${evt.timestamp}-${evt.action}-${idx}`} className={
                        evt.status === 'needs_revision' || evt.status === 'retrying' ? 'text-amber-300' :
                        evt.status === 'error' ? 'text-red-300' :
                        evt.status === 'fallback' ? 'text-amber-200' :
                        'text-slate-100'
                      }>
                        {formatTraceLine(evt)}
                      </div>
                    ))
                  ) : (
                    <p className="text-slate-400">
                      {deliberating
                        ? 'Waiting for the first trace line…'
                        : 'Run a case. Each line here is the same line the server prints.'}
                    </p>
                  )}
                </div>
              </div>
            )}

            {activeAgentTab === 'charts' && (
              <div className="saas-card rounded-2xl p-4 text-sm text-slate-700 space-y-2">
                <p className="font-semibold text-slate-900">Price band from the last response</p>
                <p className="font-mono text-xs">
                  P10 {liveResponse?.price_range_per_90kg_bag ? Math.round(liveResponse.price_range_per_90kg_bag.p10).toLocaleString() : '—'}
                  {' · '}
                  P50 {liveResponse?.price_range_per_90kg_bag ? Math.round(liveResponse.price_range_per_90kg_bag.p50).toLocaleString() : '—'}
                  {' · '}
                  P90 {liveResponse?.price_range_per_90kg_bag ? Math.round(liveResponse.price_range_per_90kg_bag.p90).toLocaleString() : '—'}
                </p>
                <p className="text-xs text-slate-500">Loss risk: —</p>
              </div>
            )}

            {/* TAB CONTENT: ZETARIS SQL INSPECTOR */}
            {activeAgentTab === 'sql' && (
              <div className="saas-card rounded-2xl p-5 space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                  <div className="flex items-center gap-2">
                    <Database className="w-4 h-4 text-emerald-700" />
                    <span className="text-xs font-bold text-slate-800">Live Zetaris Federated Query</span>
                  </div>
                  <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-semibold border ${
                    isZetarisOnline 
                      ? 'bg-emerald-50 text-emerald-800 border-emerald-200' 
                      : 'bg-amber-50 text-amber-800 border-amber-200'
                  }`}>
                    {isZetarisOnline ? 'PORT 3000 ONLINE' : 'OFFLINE (SAMPLE ACTIVE)'}
                  </span>
                </div>

                <p className="text-xs text-slate-500">This is the cross-source statement the planner sends. It is not a measured result.</p>
                <div className="p-3.5 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs overflow-x-auto leading-relaxed">
                  <div>SELECT county, latest_market_date, quote_count, forecast_date,</div>
                  <div className="pl-4">precipitation_sum, temperature_2m_mean, humidity_pct,</div>
                  <div className="pl-4">storage, daily_loss_pct, rules_synthetic</div>
                  <div>FROM maize.county_case</div>
                  <div>WHERE county = '{county}'</div>
                </div>
              </div>
            )}

            {/* SPONSOR INTEGRATION COMPLIANCE BAR */}
            <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs text-slate-600">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-700 shrink-0" />
                <span className="font-semibold text-slate-800">GenAI.Works Hackathon Compliance:</span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono">
                <span className={`px-2 py-0.5 rounded border ${isZetarisOnline ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-slate-100 text-slate-700 border-slate-200'}`}>
                  Zetaris: {isZetarisOnline ? `online · ${zetarisRowCount} rows` : 'offline'}
                </span>
                <span className={`px-2 py-0.5 rounded border ${meterlessHealth?.status === 'online' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-slate-100 text-slate-700 border-slate-200'}`}>
                  Reasoning: {liveResponse ? `${liveResponse.provider} · ${liveResponse.model}` : (providersData?.primary ?? '—')}
                </span>
                <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200">
                  Cursor IDE Built
                </span>
              </div>
            </div>

          </div>

        </div>

      </div>

      {/* ZETARIS STATUS & TABLE CHECK MODAL */}
      {showZetarisModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="saas-card w-full max-w-lg rounded-3xl p-6 bg-white shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <Database className="w-5 h-5 text-emerald-700" />
                <h3 className="text-base font-bold text-slate-900">Zetaris Federated SQL Connection</h3>
              </div>
              <button 
                onClick={() => setShowZetarisModal(false)}
                className="p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <div className="font-semibold text-slate-700">Connection Endpoint</div>
                <div className="font-mono text-slate-500">http://localhost:3000/api/proxy</div>
                <div className="text-[11px] text-slate-400">Target Tables: maize.kamis_prices, weather_daily, market_news, storage_loss_rules, farmer_ledger</div>
              </div>

              <div className="space-y-2">
                <div className="font-semibold text-slate-800">Federated Table Health:</div>
                <div className="space-y-1.5 font-mono text-xs">
                  {zetarisData?.tables && zetarisData.tables.length > 0 ? (
                    zetarisData.tables.map((tbl, i) => (
                      <div key={i} className="flex items-center justify-between p-2 rounded-lg bg-slate-50 border border-slate-200">
                        <span className="font-semibold text-slate-800">{tbl.table}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded font-semibold ${
                          tbl.status === 'online' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {tbl.status === 'online' ? `${tbl.row_count} Rows` : 'Offline'}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="p-3 text-center text-slate-500 bg-slate-50 rounded-xl border border-dashed border-slate-300">
                      No tables reported. Ensure Zetaris Docker container is running on port 3000.
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                onClick={async () => {
                  setCheckingSystem(true);
                  try {
                    const res = await api.checkZetaris();
                    setZetarisData(res);
                  } catch {
                    // ignore
                  } finally {
                    setCheckingSystem(false);
                  }
                }}
                disabled={checkingSystem}
                className="px-4 py-2 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white font-semibold text-xs transition disabled:opacity-50"
              >
                {checkingSystem ? 'Checking...' : 'Run Table Check Now'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* METERLESS / REASONING CONFIGURATION MODAL */}
      {showMeterlessModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="saas-card w-full max-w-lg rounded-3xl p-6 bg-white shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <Cpu className="w-5 h-5 text-emerald-700" />
                <h3 className="text-base font-bold text-slate-900">Meterless & AI Reasoning Provider</h3>
              </div>
              <button 
                onClick={() => setShowMeterlessModal(false)}
                className="p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3.5 text-xs">
              <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-700">Meterless Runtime Status:</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded font-mono font-semibold ${
                    meterlessHealth?.status === 'online' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                  }`}>
                    {meterlessHealth?.status?.toUpperCase() || 'OFFLINE'}
                  </span>
                </div>
                <div className="font-mono text-slate-500 text-[11px]">
                  Configured: {providersData?.providers?.find(p => p.id === 'meterless')?.base_url || 'http://127.0.0.1:8088/v1'}
                </div>
              </div>

              {/* Connect link form */}
              <form onSubmit={handleConnectLink} className="space-y-2">
                <label className="font-semibold text-slate-700 block">
                  Paste Meterless Connect Link or Token:
                </label>
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    value={connectLinkInput} 
                    onChange={(e) => setConnectLinkInput(e.target.value)}
                    placeholder="http://127.0.0.1:8088/connect#k=your-token"
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs font-mono text-slate-800 focus:outline-none focus:ring-1 focus:ring-emerald-700"
                  />
                  <button 
                    type="submit"
                    className="px-3.5 py-2 rounded-xl bg-emerald-800 hover:bg-emerald-900 text-white font-semibold text-xs transition"
                  >
                    Connect
                  </button>
                </div>
              </form>

              {connectStatusMsg && (
                <div className="p-2.5 rounded-xl bg-slate-100 text-slate-700 font-mono text-[11px]">
                  {connectStatusMsg}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleDetectMeterless}
                  className="flex-1 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold text-xs transition border border-slate-200"
                >
                  Auto-Detect Runtime
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const res = await api.testMeterless();
                    setMeterlessHealth(res);
                  }}
                  className="flex-1 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 font-semibold text-xs transition border border-slate-200"
                >
                  Test Connection Ping
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end pt-2 border-t border-slate-100">
              <button
                onClick={() => setShowMeterlessModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-900 text-white font-semibold text-xs transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
