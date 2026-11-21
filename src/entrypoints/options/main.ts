import '@/assets/ui.css';
import '@/entrypoints/content/popover.css';
import { mount } from 'svelte';
import App from './App.svelte';

mount(App, { target: document.getElementById('app')! });
