import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "File vault",
  description: "Upload objects and read older S3 versions.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
