import { Analytics } from '@vercel/analytics/next';

export const metadata = {
  title: "Araviel API",
  description: "AI orchestration platform backend",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
