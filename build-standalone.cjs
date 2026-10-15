const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const html = read('index.html')
  .replace('<link rel="stylesheet" href="style.css">', () => '<style>\n' + read('style.css') + '\n</style>')
  .replace('<script src="simulation.js" defer></script>', '')
  .replace('<script src="challenge.js" defer></script>', '')
  .replace('<script src="app.js" defer></script>', '')
  .replace('</body>', () => '<script>\n' + read('simulation.js') + '\n</script>\n<script>\n' + read('challenge.js') + '\n</script>\n<script>\n' + read('app.js') + '\n</script>\n</body>');
fs.writeFileSync(path.join(__dirname, 'NERVA.html'), html);
console.log('Standalone demo written: NERVA.html');
