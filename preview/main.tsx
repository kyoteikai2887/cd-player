import { createRoot } from 'react-dom/client';
import { PreviewApp } from './PreviewApp.tsx';
import './preview.css';

createRoot(document.getElementById('root')!).render(<PreviewApp />);
