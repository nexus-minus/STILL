import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the same build works on GitHub Pages under any
  // sub-path (user.github.io/repo/) and on a plain static file server.
  base: './',

  // The repo's assets/ folder is served as the site root:
  //   assets/map/room_001.glb  ->  /map/room_001.glb
  publicDir: 'assets',

  build: {
    // WebGPU-era browsers only; keeps top-level await and modern syntax.
    target: 'esnext',
    sourcemap: true,
    // Ship the isolated path-tracing comparison page alongside the game.
    rolldownOptions: {
      input: {
        game: 'index.html',
        pathtrace: 'pathtrace.html',
        pathtraceSanity: 'pathtrace-sanity.html',
      },
    },
  },

  server: {
    port: 5173,
  },
});
