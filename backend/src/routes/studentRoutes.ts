import { Router, type RequestHandler } from "express";
import multer from "multer";
import { authenticate } from "../middleware/auth.js";
import { checkAnyPermission, checkPermission } from "../middleware/permissions.js";
import {
  createStudent, getStudents, getStudentById,
  getStudentByLeadId, updateStudent, deleteStudent,
  getMyEnrolments,
  getEnrolment, requestInvoice, getCorrection, correctEnrolment, uploadPaymentReceipt,
} from "../controllers/studentController.js";

const router = Router();

/**
 * A receipt is a photograph or a PDF of one, so the list is short and the
 * limit is what a phone camera produces rather than what a scanner can.
 */
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(Object.assign(new Error("A receipt must be a JPG, PNG, WebP, HEIC or PDF"), { statusCode: 415 }));
  },
});

/**
 * The upload, with its two refusals said as themselves. Left to the error
 * handler they are a 500, which production reports as "Internal server error"
 * — true of nothing here, and no help to whoever chose the file.
 */
const takeReceipt: RequestHandler = (req, res, next) => {
  receiptUpload.single("file")(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return next(Object.assign(new Error("A receipt can be at most 10 MB"), { statusCode: 413 }));
    }
    next(err);
  });
};

// Static before parameterized
router.get("/by-lead/:leadId", authenticate, checkPermission("students", "view"), getStudentByLeadId);

// The receipt for a close, taken before the enrolment exists — and for the
// correction of one finance sent back. Before "/:id", or Express reads
// "receipts" as a student id.
router.post(
  "/receipts/:leadId",
  authenticate,
  checkAnyPermission(["students", "create"], ["students", "edit"]),
  takeReceipt,
  uploadPaymentReceipt,
);

// The enrolments screen: a counsellor's own sales, with the state of each
// invoice beside them, so the question does not have to be taken to finance.
// Every role has it (2026-10-03); everyone's sales only with Students → view,
// which getMyEnrolments checks.
router.get("/enrolments/mine", authenticate, getMyEnrolments);
// One enrolment, for its own page — every role, like My Enrolments; the service lets the closer, or anyone who may
// view students, see it. Before "/:id", which would take "enrolments" for a student id.
router.get("/enrolments/:id", authenticate, getEnrolment);

// Generate the invoice — the same handover that runs when a lead closes,
// asked for by hand when it never ran or did not get through.
router.post("/:id/invoice", authenticate, checkPermission("students", "edit"), requestInvoice);
// Correct an enrolment finance sent back — everything the close took — and send
// it again in the same step; with the same permission as sending it again.
router.get("/:id/correction", authenticate, checkPermission("students", "edit"), getCorrection);
router.put("/:id/correction", authenticate, checkPermission("students", "edit"), correctEnrolment);

router.get("/",    authenticate, checkPermission("students", "view"),   getStudents);
router.post("/",   authenticate, checkPermission("students", "create"), createStudent);
router.get("/:id", authenticate, checkPermission("students", "view"),   getStudentById);
router.put("/:id", authenticate, checkPermission("students", "edit"),   updateStudent);
router.delete("/:id", authenticate, checkPermission("students", "delete"), deleteStudent);

export default router;
