import { AdminApp } from '../../components/admin-app';
import { SessionProvider } from '../../components/session-provider';

export default function AdminPage() {
  return (
    <SessionProvider>
      <AdminApp />
    </SessionProvider>
  );
}
