import { createRoot } from 'react-dom/client';
import App from './App';
import { registerPwa } from './pwa';
import { initFold } from './fold';
import './styles.css';

registerPwa();
initFold();
createRoot(document.getElementById('root')!).render(<App />);
