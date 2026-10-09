import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import agents from "agents/vite";

export default defineConfig(({ command, mode }) => {
  // The rules demo still runs real Workers, Workflows, DO SQLite and WebSockets.
  // It only replaces AI text generation, and cannot change a production build.
  const rulesDemo = command === "serve" && mode === "rules";
  return {
    plugins: [
      agents(),
      react(),
      cloudflare({
        remoteBindings: !rulesDemo,
        config: rulesDemo
          ? (config) => {
              delete config.ai;
              config.vars = { ...config.vars, AUDIT_SUMMARY_MODE: "rules" };
            }
          : undefined
      }),
      tailwindcss()
    ]
  };
});
