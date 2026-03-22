global.document = { getElementById: () => null };
global.window = {};
import('./app.js').then(() => console.log('App loaded without throwing')).catch(console.error);
