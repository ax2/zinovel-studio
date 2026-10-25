process.on("message", (value) => {
  if (value === "exit") process.exit(0);
});
process.send("ready");
