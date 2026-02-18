require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const path = require("path");

const meetingsRouter = require("./routes/meetings");
const glossaryRouter = require("./routes/glossary");

const app = express();
const PORT = process.env.PORT || 3300;

app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", service: "meeting-minutes" });
});

app.use("/api/meetings", meetingsRouter);
app.use("/api/glossary", glossaryRouter);

app.listen(PORT, () => {
  console.log(`meeting-minutes server listening on port ${PORT}`);
});
