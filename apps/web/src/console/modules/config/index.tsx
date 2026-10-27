// Routing & Providers module root: #/console/config (configuration), #/console/config/changes[/:id].
import { matchPattern, useConsoleRoute } from '../../route';
import ConfigPage from './ConfigPage';
import ChangesPage from './ChangesPage';
import { ToastHost } from '../risk/kit';

export default function ConfigModule() {
  const { path } = useConsoleRoute();
  const detail = matchPattern('config/changes/:id', path);
  const page = detail?.id ? <ChangesPage selectedId={detail.id} /> : path.startsWith('config/changes') ? <ChangesPage /> : <ConfigPage />;
  return (
    <>
      {page}
      <ToastHost />
    </>
  );
}
