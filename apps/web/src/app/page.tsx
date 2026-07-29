import { SessionProvider } from '../components/session-provider';
import { MiniApp } from '../components/mini-app';

export default function Page() {
  return (
    <SessionProvider>
      <MiniApp />
    </SessionProvider>
  );
}
