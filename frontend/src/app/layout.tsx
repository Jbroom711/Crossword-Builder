import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

export const metadata: Metadata = {
  title: "Crossword Builder",
  description: "Build crossword puzzles with automatic grid layout",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html lang="en">
        <head>
          <link rel="preconnect" href="https://fonts.googleapis.com" />
          <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
          <link
            href="https://fonts.googleapis.com/css2?family=Libre+Franklin:wght@300;400;500;600;700&family=Playfair+Display:wght@400;700;900&display=swap"
            rel="stylesheet"
          />
        </head>
        <body>
          <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
