import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        control: resolve(__dirname, "index.html"),
        projector: resolve(__dirname, "projector/index.html"),
      },
    },
  },
});
