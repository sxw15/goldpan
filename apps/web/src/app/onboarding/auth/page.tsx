// apps/web/src/app/onboarding/auth/page.tsx
//
// F7 — wizard step 7 (auth). This is a server component so we can read
// NODE_ENV at render time and pass it down as a prop. Could go through a
// runtime-info API instead, but a server component is simpler and avoids the
// extra round trip / loading-flash on a page that already has zero other
// async deps.
//
// In dev (`pnpm dev`) NODE_ENV is 'development' — auth toggle defaults OFF.
// In prod (`pnpm start` after `pnpm build`) it's 'production' — toggle is
// hidden and a password is required to advance. Self-host single-machine is
// the assumed deployment, so the web's NODE_ENV matches the server's.
import { AuthForm } from './_form';

export default function AuthPage() {
  const isProduction = process.env.NODE_ENV === 'production';
  return <AuthForm isProduction={isProduction} />;
}
