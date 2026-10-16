const fs = require('node:fs');
const path = require('node:path');
const release = require('./build-version.cjs');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const style = () => read('style.css').replace('url("assets/panel-noise.png")', () => 'url("data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'assets/panel-noise.png')).toString('base64') + '")');
const html = read('index.html')
  .replace('<link rel="stylesheet" href="style.css">', () => '<style>\n' + style() + '\n</style>')
  .replace('<script src="simulation.js" defer></script>', '')
  .replace('<script src="systems.js" defer></script>', '')
  .replace('<script src="thermo-table.js" defer></script>', '')
  .replace('<script src="thermochemistry.js" defer></script>', '')
  .replace('<script src="version.js" defer></script>', '')
  .replace('<script src="leaderboard.js" defer></script>', '')
  .replace('<script src="audio.js" defer></script>', '')
  .replace('<script src="settings.js" defer></script>', '')
  .replace('<script src="performance.js" defer></script>', '')
  .replace('<script src="challenge.js" defer></script>', '')
  .replace('<script src="app.js" defer></script>', '')
  .replace('</body>', () => ['version.js', 'thermo-table.js', 'thermochemistry.js', 'systems.js', 'simulation.js', 'challenge.js', 'leaderboard.js', 'audio.js', 'settings.js', 'performance.js', 'app.js'].map(file => '<script>\n' + read(file) + '\n</script>').join('\n') + '\n</body>')
  .replace(/\r\n/g, '\n').replace(/^[\t ]+$/gm, '');
fs.writeFileSync(path.join(__dirname, 'NERVA.html'), html);
console.log('Standalone demo written: NERVA.html / ' + release.label);
