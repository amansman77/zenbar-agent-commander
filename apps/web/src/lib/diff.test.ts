import { parseDiffFiles } from "./diff";

describe("parseDiffFiles", () => {
  it("defaults to modified when no new/deleted/renamed header line is present", () => {
    const [file] = parseDiffFiles("diff --git a/app/foo.py b/app/foo.py\n@@ -1,1 +1,1 @@\n-old\n+new");
    expect(file.status).toBe("modified");
  });

  it("detects an added file from its new file mode line", () => {
    const [file] = parseDiffFiles(
      "diff --git a/app/new.py b/app/new.py\nnew file mode 100644\n@@ -0,0 +1,1 @@\n+hello"
    );
    expect(file.status).toBe("added");
  });

  it("detects a deleted file from its deleted file mode line", () => {
    const [file] = parseDiffFiles(
      "diff --git a/app/old.py b/app/old.py\ndeleted file mode 100644\n@@ -1,1 +0,0 @@\n-bye"
    );
    expect(file.status).toBe("deleted");
  });

  it("detects a renamed file from its rename from/to lines", () => {
    const [file] = parseDiffFiles("diff --git a/app/to.py b/app/to.py\nrename from app/from.py\nrename to app/to.py");
    expect(file.status).toBe("renamed");
  });

  it("tracks status independently per file in a multi-file diff", () => {
    const rawDiff = [
      "diff --git a/added.py b/added.py",
      "new file mode 100644",
      "@@ -0,0 +1,1 @@",
      "+hello",
      "diff --git a/unchanged_type.py b/unchanged_type.py",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new"
    ].join("\n");
    const files = parseDiffFiles(rawDiff);
    expect(files.map((f) => [f.fileName, f.status])).toEqual([
      ["added.py", "added"],
      ["unchanged_type.py", "modified"]
    ]);
  });
});
