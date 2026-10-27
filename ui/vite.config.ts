import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxy = {
  "/api": {
    target: "http://127.0.0.1:8000",
    changeOrigin: true,
    timeout: 0,
    proxyTimeout: 0,
    rewrite: (path: string) => path.replace(/^\/api/, ""),
    configure: (proxy: { on: (event: string, handler: (...args: never[]) => void) => void }) => {
      proxy.on("proxyRes", ((proxyRes: { headers: Record<string, string | string[] | undefined> }, req: { url?: string }) => {
        if (req.url?.includes("/events")) {
          delete proxyRes.headers["content-length"];
          proxyRes.headers["cache-control"] = "no-cache, no-transform";
          proxyRes.headers["x-accel-buffering"] = "no";
        }
      }) as never);
    },
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 3001,
    proxy: apiProxy,
  },
  preview: { proxy: apiProxy },
});
