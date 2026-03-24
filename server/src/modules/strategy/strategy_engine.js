const path = require('path');
const fs = require('fs');

class StrategyEngine {
  constructor() {
    this.strategies = new Map();
  }

  loadBuiltinStrategies() {
    const builtinDir = path.join(__dirname, 'builtin');
    if (!fs.existsSync(builtinDir)) return;

    const files = fs.readdirSync(builtinDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      try {
        const strategy = require(path.join(builtinDir, file));
        if (strategy.name && strategy.evaluate) {
          this.strategies.set(strategy.name, strategy);
        }
      } catch (err) {
        console.error(`Failed to load builtin strategy ${file}:`, err.message);
      }
    }
  }

  loadCustomStrategies(dir) {
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      try {
        const strategy = require(path.join(dir, file));
        if (strategy.name && strategy.evaluate) {
          this.strategies.set(strategy.name, strategy);
          console.log(`Loaded custom strategy: ${strategy.name}`);
        }
      } catch (err) {
        console.error(`Failed to load custom strategy ${file}:`, err.message);
      }
    }
  }

  getStrategy(name) {
    return this.strategies.get(name);
  }

  getStrategyNames() {
    return Array.from(this.strategies.keys());
  }

  getAllStrategies() {
    return Array.from(this.strategies.entries()).map(([name, strategy]) => ({
      name,
      description: strategy.description || '',
      defaultConfig: strategy.defaultConfig || {}
    }));
  }
}

module.exports = { StrategyEngine };
