interface ImportMetaEnv {
  /** Optional Google Maps Platform key baked in at build time. */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
}

/** Version and build date, set in vite.config.ts. */
declare const __APP_VERSION__: string;
