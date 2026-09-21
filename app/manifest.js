export default function manifest() {
  return {
    name: "Khedma | خدمة",
    short_name: "Khedma",
    description: "Saudi freelance marketplace",
    start_url: "/",
    display: "standalone",
    background_color: "#eef2fb",
    theme_color: "#eef2fb",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  };
}
