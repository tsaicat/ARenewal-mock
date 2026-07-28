import "./globals.css";

export const metadata = {
  title: "Mock Renewal Email API",
  description: "Mock Email API for PAS Auto-Renewal — inbox, replies, and audit log.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
