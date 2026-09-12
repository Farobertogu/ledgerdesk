if (process.argv[2] === 'timeout') setInterval(() => {}, 1000);
else if (process.argv[2] === 'output') {
  const block = Buffer.alloc(65536, 120);
  function next() { if (process.stdout.write(block)) setImmediate(next); else process.stdout.once('drain', next); }
  next();
} else process.exitCode = 2;
