import { createRoot } from 'react-dom/client';
import App from './App';
import DevApp from './DevApp';
import './styles.css';

// Two windows, one app: http://localhost:5173/ = marketing, http://localhost:5173/developer = developer.
const isDev = location.pathname.replace(/\/+$/, '') === '/developer';
createRoot(document.getElementById('root')!).render(isDev ? <DevApp /> : <App />);
