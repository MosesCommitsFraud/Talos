import { createRoot } from 'react-dom/client';
import { HtmlPreview } from '../src/components/HtmlPreview';
import '../src/i18n';
import '../src/styles/index.css';

const root = createRoot(document.getElementById('root')!);
Object.assign(window, {setFixture(text: string, name = 'dashboard.html') {
  root.render(<div style={{height: '95vh'}}><HtmlPreview text={text} name={name} url="about:blank" /></div>);
}});
