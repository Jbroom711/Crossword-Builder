import type { MetadataRoute } from "next";

// Web app manifest — controls the icon and name shown when a user adds the site
// to their phone home screen (Android/Chrome), and lets it launch standalone.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Crossword Builder",
    short_name: "Crossword",
    description: "Build crossword puzzles with automatic grid layout",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f5f0",
    theme_color: "#000000",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
