import Express from "express";
const router = Express.Router();

/* GET home page. */
router.get("/", function (req, res) {
  res.render("index", { title: "Express" });
});