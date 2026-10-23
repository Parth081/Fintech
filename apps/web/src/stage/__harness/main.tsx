import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import '../../styles.css';
import { MainStage } from '../MainStage';
createRoot(document.getElementById('root')!).render(<StrictMode><MainStage /></StrictMode>);
