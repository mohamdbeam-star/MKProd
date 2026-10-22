import { createRoot } from 'react-dom/client';
import App from './App';
import { registerPwa } from './pwa';
import './styles.css';

registerPwa();
createRoot(document.getElementById('root')!).render(<App />);
