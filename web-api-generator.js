// web-api-generator.js
const express = require("express");
const bodyParser = require("body-parser");
const archiver = require("archiver");
const multer = require("multer");
const fs = require("fs").promises;
const path = require("path");
const fsExtra = require("fs-extra");
const { execSync } = require("child_process");
const AdmZip = require("adm-zip");

let uuidv4;
(async () => {
  const uuidModule = await import("uuid");
  uuidv4 = uuidModule.v4;
})();

const app = express();

app.use(express.static("public"));
app.use(bodyParser.json({ limit: "10mb" }));

// Multer for /update-project (handles file and text fields)
const updateStorage = multer.memoryStorage();
const updateUpload = multer({
  storage: updateStorage,
  fileFilter: (req, file, cb) => {
    console.log("Multer fileFilter:", {
      fieldname: file.fieldname,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    });
    if (file.fieldname !== "projectFile") {
      return cb(new Error(`Unexpected field: ${file.fieldname}`));
    }
    if (
      file.mimetype !== "application/zip" &&
      file.mimetype !== "application/x-zip-compressed"
    ) {
      return cb(new Error("Only ZIP files are allowed"));
    }
    if (file.size === 0) {
      return cb(new Error("Uploaded file is empty"));
    }
    cb(null, true);
  },
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
    files: 1,
  },
}).fields([
  { name: "projectFile", maxCount: 1 },
  { name: "mode" },
  { name: "framework" },
  { name: "schemas" },
  { name: "nodejsDbName" },
  { name: "nodejsConnectionString" },
  { name: "nodejsUseAuth" },
  { name: "nodejsUsername" },
  { name: "nodejsPassword" },
  { name: "dotnetDbName" },
  { name: "dotnetConnectionString" },
  { name: "dotnetUseAuth" },
  { name: "dotnetUsername" },
  { name: "dotnetPassword" },
  { name: "dbName" },
  { name: "connectionString" },
  { name: "useAuth" },
  { name: "username" },
  { name: "password" },
]);

// Multer for /parse-ai and /generate (handles only text fields)
const textUpload = multer();

// Error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error("Multer error:", err);
    return res.status(400).json({ error: `Multer error: ${err.message}` });
  }
  next(err);
});

// Update project endpoint
app.post("/update-project", updateUpload, async (req, res) => {
  try {
    console.log("Request headers:", req.headers);
    console.log("Request body:", req.body);
    console.log(
      "Uploaded files:",
      req.files ? JSON.stringify(req.files) : "No files"
    );

    const { mode = "update", framework } = req.body;

    if (mode !== "update") {
      return res
        .status(400)
        .json({ error: "Invalid mode for update endpoint" });
    }

    if (
      !req.files ||
      !req.files.projectFile ||
      req.files.projectFile.length === 0
    ) {
      return res
        .status(400)
        .json({ error: "Project file is required for update mode" });
    }

    const projectFile = req.files.projectFile[0];
    let schemas;
    try {
      schemas = JSON.parse(req.body.schemas);
    } catch (parseErr) {
      return res
        .status(400)
        .json({ error: "Invalid schemas JSON: " + parseErr.message });
    }

    if (!framework || !Array.isArray(schemas) || schemas.length === 0) {
      return res
        .status(400)
        .json({ error: "Missing or invalid framework/schemas" });
    }

    let payload;
    if (framework === "both") {
      const nodejsUseAuth = req.body.nodejsUseAuth === "on";
      const dotnetUseAuth = req.body.dotnetUseAuth === "on";
      payload = {
        framework: "both",
        mode: "update",
        nodejsDbConfig: {
          dbName: req.body.nodejsDbName,
          connectionString: req.body.nodejsConnectionString,
          useAuth: nodejsUseAuth,
          ...(nodejsUseAuth
            ? {
                username: req.body.nodejsUsername,
                password: req.body.nodejsPassword,
              }
            : {}),
        },
        dotnetDbConfig: {
          dbName: req.body.dotnetDbName,
          connectionString: req.body.dotnetConnectionString,
          useAuth: dotnetUseAuth,
          ...(dotnetUseAuth
            ? {
                username: req.body.dotnetUsername,
                password: req.body.dotnetPassword,
              }
            : {}),
        },
        schemas,
        projectFile,
      };
    } else {
      const dbConfig =
        typeof req.body.dbConfig === "string"
          ? JSON.parse(req.body.dbConfig)
          : req.body.dbConfig;
      payload = {
        framework,
        mode: "update",
        dbConfig: { ...dbConfig, schemas },
        schemas,
        projectFile,
      };
    }

    console.log("Payload:", payload);
    await updateExistingProject(payload, res);
  } catch (error) {
    console.error("Update error:", error);
    res.status(500).json({ error: "Update failed: " + error.message });
  }
});

// AI parsing endpoint
app.post("/parse-ai", textUpload.none(), async (req, res) => {
  try {
    const { description } = req.body;
    if (!description) {
      return res.status(400).json({ error: "Missing description" });
    }
    const schemas = parseNaturalLanguage(description);
    res.json({ schemas });
  } catch (error) {
    console.error("AI parse error:", error);
    res.status(400).json({ error: error.message });
  }
});

app.post("/generate", textUpload.none(), async (req, res) => {
  try {
    console.log("Received req.body:", req.body);
    const payload = req.body;
    let schemas;
    let dbConfig;

    // Parse schemas
    try {
      schemas = JSON.parse(payload.schemas);
    } catch (parseErr) {
      return res
        .status(400)
        .json({ error: "Invalid schemas JSON: " + parseErr.message });
    }

    // Parse dbConfig
    try {
      dbConfig =
        typeof payload.dbConfig === "string"
          ? JSON.parse(payload.dbConfig)
          : payload.dbConfig;
    } catch (parseErr) {
      return res
        .status(400)
        .json({ error: "Invalid dbConfig JSON: " + parseErr.message });
    }

    // Validate required fields
    if (!payload.framework || !Array.isArray(schemas) || schemas.length === 0) {
      return res
        .status(400)
        .json({ error: "Missing or invalid framework/schemas" });
    }
    if (!dbConfig.dbName || !dbConfig.connectionString) {
      return res
        .status(400)
        .json({ error: "Missing dbName or connectionString in dbConfig" });
    }
    if (dbConfig.useAuth && (!dbConfig.username || !dbConfig.password)) {
      return res
        .status(400)
        .json({ error: "Username and password required when useAuth is true" });
    }

    // Create full payload with parsed schemas and dbConfig
    const fullPayload = { ...payload, schemas, dbConfig };

    await generateAndZipProject(fullPayload, res);
  } catch (error) {
    console.error("POST error:", error);
    res.status(500).json({ error: "Generation failed: " + error.message });
  }
});
// Helper functions
async function updateExistingProject(payload, res) {
  const {
    framework,
    mode,
    schemas,
    projectFile,
    dbConfig,
    nodejsDbConfig,
    dotnetDbConfig,
  } = payload;
  const tempDir = path.join(__dirname, `temp-update-${uuidv4()}`);
  const extractedDir = path.join(tempDir, "extracted");
  const updatedDir = path.join(tempDir, "updated-project");
  const outputZipPath = path.join(
    tempDir,
    `updated-project-${framework}-${Date.now()}.zip`
  );

  try {
    console.log(`📁 Temp directories created: ${tempDir}`);
    await fsExtra.ensureDir(tempDir);
    await fsExtra.ensureDir(extractedDir);
    await fsExtra.ensureDir(updatedDir);

    console.log("📦 Extracting existing project...");
    const zip = new AdmZip(projectFile.buffer);
    try {
      zip.extractAllTo(extractedDir, true);
      console.log("📦 Existing project extracted");
      const extractedFiles = await fsExtra.readdir(extractedDir, {
        withFileTypes: true,
      });
      console.log(
        "📂 Extracted files:",
        extractedFiles.map((f) => ({ name: f.name, isDir: f.isDirectory() }))
      );
    } catch (zipError) {
      console.error("ZIP extraction error:", zipError);
      throw new Error("Failed to extract project ZIP file");
    }

    const projectStructure = await detectProjectStructure(extractedDir);
    console.log("🔍 Detected project structure:", projectStructure);

    if (
      framework === "both" &&
      (!projectStructure.hasNodejs || !projectStructure.hasDotnet)
    ) {
      throw new Error(
        'Both Node.js and .NET projects are required for framework "both"'
      );
    } else if (framework === "nodejs" && !projectStructure.hasNodejs) {
      throw new Error(
        'Node.js project is required for framework "nodejs". Ensure the uploaded ZIP contains a package.json file.'
      );
    } else if (framework === "dotnet" && !projectStructure.hasDotnet) {
      throw new Error('.NET project is required for framework "dotnet"');
    }

    if (framework === "both") {
      console.log("🔄 Updating Node.js project...");
      await updateNodeJsProject(
        projectStructure.nodejsPath,
        path.join(updatedDir, "nodejs"),
        schemas,
        nodejsDbConfig
      );
      console.log("🔄 Updating .NET project...");
      await updateDotNetProject(
        projectStructure.dotnetPath,
        path.join(updatedDir, "dotnet"),
        schemas,
        dotnetDbConfig
      );
    } else if (framework === "nodejs") {
      console.log("🔄 Updating Node.js project...");
      await updateNodeJsProject(
        projectStructure.nodejsPath,
        updatedDir,
        schemas,
        dbConfig
      );
    } else if (framework === "dotnet") {
      console.log("🔄 Updating .NET project...");
      await updateDotNetProject(
        projectStructure.dotnetPath,
        updatedDir,
        schemas,
        dbConfig
      );
    }

    console.log("📂 Files in updated directory:");
    const updatedFiles = await getAllFiles(updatedDir);
    console.log(updatedFiles);

    console.log("📦 Creating updated ZIP...");
    const output = fsExtra.createWriteStream(outputZipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (err) => {
      console.error("Archiver error:", err);
      throw new Error("Failed to create ZIP file");
    });

    archive.on("progress", (data) => {
      console.log(
        `📦 Archiving progress: ${data.entries.processed}/${data.entries.total} entries`
      );
    });

    archive.on("end", () => {
      console.log(
        `✅ ZIP creation completed: ${outputZipPath} (${archive.pointer()} bytes)`
      );
    });

    archive.pipe(output);
    archive.directory(updatedDir, false);

    await new Promise((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
      archive.finalize();
    });

    console.log("🔎 Verifying generated ZIP file...");
    try {
      const verifyZip = new AdmZip(outputZipPath);
      const zipEntries = verifyZip.getEntries();
      console.log(
        "📂 ZIP contents:",
        zipEntries.map((entry) => entry.entryName)
      );
      if (zipEntries.length === 0) {
        throw new Error("Generated ZIP file is empty");
      }
    } catch (verifyError) {
      console.error("ZIP verification error:", verifyError);
      throw new Error("Generated ZIP file is invalid or corrupted");
    }

    console.log("📤 Sending ZIP file to client...");
    res.download(outputZipPath, path.basename(outputZipPath), async (err) => {
      if (err) {
        console.error("Download error:", err);
        res.status(500).json({ error: "Failed to send updated project" });
      } else {
        console.log("✅ ZIP file sent successfully");
      }
      try {
        // Retry cleanup with delay to handle EBUSY
        let retries = 3;
        while (retries > 0) {
          try {
            await fsExtra.remove(tempDir);
            console.log("🧹 Temp directory cleaned up");
            break;
          } catch (cleanupErr) {
            if (cleanupErr.code === "EBUSY" && retries > 1) {
              console.warn(
                `⚠️ EBUSY during cleanup, retrying (${
                  retries - 1
                } attempts left)...`
              );
              await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
              retries--;
            } else {
              throw cleanupErr;
            }
          }
        }
      } catch (cleanupErr) {
        console.error("Cleanup error:", cleanupErr);
      }
    });
  } catch (error) {
    console.error("Update error:", error);
    try {
      let retries = 3;
      while (retries > 0) {
        try {
          await fsExtra.remove(tempDir);
          console.log("🧹 Temp directory cleaned up after error");
          break;
        } catch (cleanupErr) {
          if (cleanupErr.code === "EBUSY" && retries > 1) {
            console.warn(
              `⚠️ EBUSY during cleanup, retrying (${
                retries - 1
              } attempts left)...`
            );
            await new Promise((resolve) => setTimeout(resolve, 1000));
            retries--;
          } else {
            throw cleanupErr;
          }
        }
      }
    } catch (cleanupErr) {
      console.error("Cleanup error:", cleanupErr);
    }
    res.status(500).json({ error: `Update failed: ${error.message}` });
  }
}

async function getAllFiles(dir) {
  const results = [];
  const files = await fs.readdir(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      const subFiles = await getAllFiles(fullPath);
      results.push(...subFiles);
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

async function detectProjectStructure(extractDir) {
  const structure = {
    type: "unknown",
    hasNodejs: false,
    hasDotnet: false,
    nodejsPath: null,
    dotnetPath: null,
  };

  try {
    const files = await fsExtra.readdir(extractDir);

    const hasPackageJson = files.includes("package.json");
    const hasServerJs = files.includes("server.js");
    const hasNodeModules = files.includes("node_modules");

    const hasCsproj = files.some((file) => file.endsWith(".csproj"));
    const hasProgramCs = files.includes("Program.cs");
    const hasAppsettingsJson = files.includes("appsettings.json");

    const hasNodejsFolder = files.includes("nodejs");
    const hasDotnetFolder = files.includes("dotnet");

    if (hasNodejsFolder && hasDotnetFolder) {
      structure.type = "both";
      structure.hasNodejs = true;
      structure.hasDotnet = true;
      structure.nodejsPath = path.join(extractDir, "nodejs");
      structure.dotnetPath = path.join(extractDir, "dotnet");
    } else if (hasPackageJson || hasServerJs || hasNodeModules) {
      structure.type = "nodejs";
      structure.hasNodejs = true;
      structure.nodejsPath = extractDir;
    } else if (hasCsproj || hasProgramCs || hasAppsettingsJson) {
      structure.type = "dotnet";
      structure.hasDotnet = true;
      structure.dotnetPath = extractDir;
    }

    return structure;
  } catch (error) {
    console.error("Error detecting project structure:", error);
    return structure;
  }
}

async function getExistingDotNetEntities(projectPath) {
  const modelsDir = path.join(projectPath, "Models");
  if (!(await fsExtra.pathExists(modelsDir))) {
    return [];
  }
  try {
    const files = await fsExtra.readdir(modelsDir);
    return files
      .filter((f) => f.endsWith(".cs") && !f.includes("Snapshot"))
      .map((f) => path.basename(f, ".cs"));
  } catch (error) {
    console.error("Error reading Models dir:", error);
    return [];
  }
}

async function updateNodeJsProject(sourcePath, targetPath, schemas, dbConfig) {
  console.log(`📂 Copying Node.js project from ${sourcePath} to ${targetPath}`);
  await fsExtra.copy(sourcePath, targetPath);

  const entities = schemas.map((s) => s.entity);

  const packageJsonPath = path.join(targetPath, "package.json");
  if (await fsExtra.pathExists(packageJsonPath)) {
    const packageJson = await fsExtra.readJson(packageJsonPath);
    packageJson.dependencies = packageJson.dependencies || {};
    packageJson.dependencies.express = "^4.18.0";
    packageJson.dependencies.mongoose = "^8.0.0";
    packageJson.dependencies.cors = "^2.8.5";
    packageJson.dependencies.morgan = "^1.10.0";
    packageJson.dependencies.dotenv = "^16.3.1";
    packageJson.dependencies.helmet = "^7.1.0";
    packageJson.dependencies["express-rate-limit"] = "^7.4.0";
    packageJson.dependencies["express-validator"] = "^7.2.0";
    await fsExtra.writeJson(packageJsonPath, packageJson, { spaces: 2 });
    console.log("✅ package.json updated");
  } else {
    console.warn("⚠️ package.json not found, creating new one");
    await fsExtra.writeJson(
      packageJsonPath,
      generateNodeJSPackageJson(entities),
      { spaces: 2 }
    );
    console.log("✅ package.json created");
  }

  const dbConfigPath = path.join(targetPath, "config", "database.js");
  await fsExtra.ensureDir(path.dirname(dbConfigPath));
  await fsExtra.writeFile(dbConfigPath, generateNodeJSConfig(dbConfig).trim());
  console.log("✅ config/database.js updated");

  for (const schema of schemas) {
    const entity = schema.entity;
    const fields = schema.fields;

    const modelPath = path.join(targetPath, "models", `${entity}.js`);
    if (!(await fsExtra.pathExists(modelPath))) {
      await fsExtra.ensureDir(path.dirname(modelPath));
      await fsExtra.writeFile(
        modelPath,
        generateNodeJSModel(entity, fields).trim()
      );
      console.log(`✅ models/${entity}.js generated`);
    }

    const routePath = path.join(targetPath, "routes", `${entity}.js`);
    if (!(await fsExtra.pathExists(routePath))) {
      await fsExtra.ensureDir(path.dirname(routePath));
      await fsExtra.writeFile(
        routePath,
        generateNodeJSRoute(entity, fields).trim()
      );
      console.log(`✅ routes/${entity}.js generated`);
    }

    const controllerPath = path.join(
      targetPath,
      "controllers",
      `${entity}Controller.js`
    );
    if (!(await fsExtra.pathExists(controllerPath))) {
      await fsExtra.ensureDir(path.dirname(controllerPath));
      await fsExtra.writeFile(
        controllerPath,
        generateNodeJSController(entity, fields).trim()
      );
      console.log(`✅ controllers/${entity}Controller.js generated`);
    }
  }

  console.log("📝 Incrementally updating server.js with new routes...");
  await updateNodejsServerFile(targetPath, entities);

  console.log("📝 Updating README.md...");
  const readmePath = path.join(targetPath, "README.md");
  await fsExtra.writeFile(
    readmePath,
    generateNodeJSReadme(entities, dbConfig).trim()
  );
  console.log("✅ README.md updated");

  console.log("✅ Node.js project updated successfully");
}

async function updateNodejsServerFile(
  projectPath,
  newEntities,
  isBothMode = false
) {
  const serverFilePath = path.join(projectPath, "server.js");

  if (!(await fsExtra.pathExists(serverFilePath))) {
    console.warn("server.js not found, skipping server update");
    return;
  }

  let serverContent = await fsExtra.readFile(serverFilePath, "utf8");

  for (const entity of newEntities) {
    const importLine = `const ${entity}Routes = require('./routes/${entity}');`;
    if (!serverContent.includes(importLine)) {
      const importRegex = /const \w+ = require\('\w+'\);/g;
      const matches = [...serverContent.matchAll(importRegex)];
      let insertIndex = 0;
      if (matches.length > 0) {
        const lastImport = matches[matches.length - 1];
        insertIndex = lastImport.index + lastImport[0].length;
      } else {
        insertIndex = serverContent.indexOf("\n") + 1;
      }
      serverContent =
        serverContent.slice(0, insertIndex) +
        "\n" +
        importLine +
        serverContent.slice(insertIndex);
      console.log(`Added import for ${entity}Routes`);
    }
  }

  for (const entity of newEntities) {
    const lowerEntity = entity.toLowerCase();
    const routeLine = `app.use('/api/${lowerEntity}s', ${entity}Routes);`;
    if (!serverContent.includes(routeLine)) {
      const routeRegex = /app\.use\('\/api\/\w+s', \w+Routes\);/g;
      const routeMatches = [...serverContent.matchAll(routeRegex)];
      let insertIndex = 0;
      if (routeMatches.length > 0) {
        const lastRoute = routeMatches[routeMatches.length - 1];
        insertIndex = lastRoute.index + lastRoute[0].length;
      } else {
        const healthCheckIndex = serverContent.indexOf("app.get('/',");
        if (healthCheckIndex !== -1) {
          insertIndex = healthCheckIndex;
        } else {
          insertIndex = serverContent.indexOf("app.listen(PORT");
        }
      }
      serverContent =
        serverContent.slice(0, insertIndex) +
        routeLine +
        "\n" +
        serverContent.slice(insertIndex);
      console.log(`Added route for /api/${lowerEntity}s`);
    }
  }

  const endpointsRegex = /endpoints: \[([^\]]*)\]/s;
  const totalApisRegex = /totalAPIs: \d+/;
  let allEndpoints = [];

  const endpointsMatch = serverContent.match(endpointsRegex);
  if (endpointsMatch) {
    const existingEndpoints = endpointsMatch[1];
    const endpointList = existingEndpoints
      .split(",")
      .map((ep) => ep.trim().replace(/'/g, ""))
      .filter((ep) => ep.startsWith("/api/") && ep.endsWith("s"));
    allEndpoints = [...endpointList];
  }

  for (const entity of newEntities) {
    const newEndpoint = `/api/${entity.toLowerCase()}s`;
    if (!allEndpoints.includes(newEndpoint)) {
      allEndpoints.push(newEndpoint);
    }
  }

  allEndpoints.sort();
  const endpointsStr = allEndpoints.map((ep) => `'${ep}'`).join(", ");
  serverContent = serverContent.replace(
    endpointsRegex,
    `endpoints: [${endpointsStr}]`
  );

  serverContent = serverContent.replace(
    totalApisRegex,
    `totalAPIs: ${allEndpoints.length}`
  );

  const consoleLogRegex =
    /console\.log\(`📋 Available endpoints \(\\\${[\s\S]*?(?=console\.log\('🔒)/s;
  const newConsoleLogs =
    `console.log(\`📋 Available endpoints (\${${allEndpoints.length} APIs):\`);\n  ` +
    allEndpoints
      .map(
        (endpoint) =>
          `console.log(\`  - http://localhost:\${PORT}${endpoint}\`);`
      )
      .join("\n  ") +
    `\n  console.log(\`  - http://localhost:\${PORT}/ (health check)\`);\n  `;

  serverContent = serverContent.replace(consoleLogRegex, newConsoleLogs);

  const healthCheckRegex = /res\.json\(\{([\s\S]*?)\}\);/;
  const healthCheckMatch = serverContent.match(healthCheckRegex);
  if (healthCheckMatch) {
    let healthCheckBody = healthCheckMatch[1];
    if (!healthCheckBody.includes("lastUpdate")) {
      healthCheckBody = healthCheckBody.replace(
        /version: '1\.0\.0',/,
        `version: '1.0.0',\n          lastUpdate: new Date().toISOString(),`
      );
      serverContent = serverContent.replace(
        healthCheckRegex,
        `res.json({${healthCheckBody}});`
      );
    }
  }

  if (!serverContent.includes("✨ APIs updated successfully!")) {
    const listenRegex = /console\.log\('🔒.*?\);/;
    serverContent = serverContent.replace(
      listenRegex,
      `$&\n      console.log("✨ APIs updated successfully!");`
    );
  }

  await fsExtra.outputFile(serverFilePath, serverContent);
  console.log("📝 server.js updated with new routes, endpoints, and totalAPIs");
}

async function updateDotNetProgram(projectPath, entities, dbConfig) {
  const programPath = path.join(projectPath, "Program.cs");
  if (!(await fsExtra.pathExists(programPath))) {
    console.warn("Program.cs not found, creating new one");
    await fsExtra.outputFile(
      programPath,
      generateDotNetProgram(entities, dbConfig)
    );
    return;
  }

  let programContent = await fsExtra.readFile(programPath, "utf8");

  const endpointsRegex = /Endpoints = new\[\] \{ ([^\}]+) \}/;
  const totalApisRegex = /TotalAPIs = \d+/;
  const endpoints = entities
    .map((entity) => `"/api/${entity}s"`)
    .sort()
    .join(", ");
  programContent = programContent.replace(
    endpointsRegex,
    `Endpoints = new[] { ${endpoints} }`
  );
  programContent = programContent.replace(
    totalApisRegex,
    `TotalAPIs = ${entities.length}`
  );

  await fsExtra.outputFile(programPath, programContent);
  console.log("✅ Program.cs updated with new endpoints");
}

function generateTempMigrationContext(entities, dbConfig) {
  const entityConfigs = entities
    .map((entity) => `public DbSet<${entity}> ${entity}s { get; set; }`)
    .join("\n    ");

  return `// Data/TempMigrationContext.cs
using Microsoft.EntityFrameworkCore;
using DotNetApi.Models;

namespace DotNetApi.Data;

public class TempMigrationContext : DbContext
{
    public TempMigrationContext(DbContextOptions<TempMigrationContext> options) : base(options)
    {
    }

    ${entityConfigs}
}
`;
}

function generateTempMigrationContextFactory(dbConfig) {
  const server = dbConfig.connectionString;
  const dbName = dbConfig.dbName;
  const baseConn = `Server=${server};Database=${dbName};`;
  let connectionString;
  if (dbConfig.useAuth) {
    connectionString = `${baseConn}User Id=${dbConfig.username};Password=${dbConfig.password};TrustServerCertificate=True;MultipleActiveResultSets=true;`;
  } else {
    connectionString = `${baseConn}Trusted_Connection=True;TrustServerCertificate=True;MultipleActiveResultSets=true;`;
  }

  const escapedConnectionString = connectionString.replace(/\\/g, "\\\\");

  return `// Data/TempMigrationContextFactory.cs
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using DotNetApi.Data;

namespace DotNetApi.Data;

public class TempMigrationContextFactory : IDesignTimeDbContextFactory<TempMigrationContext>
{
    public TempMigrationContext CreateDbContext(string[] args)
    {
        var optionsBuilder = new DbContextOptionsBuilder<TempMigrationContext>();
        optionsBuilder.UseSqlServer("${escapedConnectionString}");
        return new TempMigrationContext(optionsBuilder.Options);
    }
}
`;
}

async function fixMigrationFiles(targetPath, migrationName) {
  const migrationsPath = path.join(targetPath, "Migrations");
  if (!(await fsExtra.pathExists(migrationsPath))) {
    console.log("ℹ️ No Migrations folder found, skipping migration file fixes");
    return;
  }

  // Recursively find all .cs files in Migrations directory and subdirectories
  async function findCsFiles(dir) {
    const results = [];
    const files = await fsExtra.readdir(dir, { withFileTypes: true });
    for (const file of files) {
      const filePath = path.join(dir, file.name);
      if (file.isDirectory()) {
        results.push(...(await findCsFiles(filePath)));
      } else if (file.name.endsWith(".cs")) {
        results.push(filePath);
      }
    }
    return results;
  }

  const migrationFiles = await findCsFiles(migrationsPath);

  for (const filePath of migrationFiles) {
    const relativePath = path.relative(targetPath, filePath);
    let content = await fsExtra.readFile(filePath, "utf8");

    console.log(`📄 Contents of ${relativePath} before fixing:`, content);

    // Replace TempMigrationContext and related references
    let updatedContent = content
      .replace(/TempMigrationContext/g, "ApplicationDbContext")
      .replace(
        /typeof\(TempMigrationContext\)/g,
        "typeof(ApplicationDbContext)"
      )
      .replace(/DotNetApi\.Migrations\.TempMigration/g, "DotNetApi.Data");

    // Determine new file path for renaming if needed
    let newFilePath = filePath;
    if (
      path.basename(filePath).includes("TempMigrationContextModelSnapshot.cs")
    ) {
      newFilePath = path.join(
        path.dirname(filePath),
        "ApplicationDbContextModelSnapshot.cs"
      );
      console.log(
        `📝 Renaming ${path.basename(
          filePath
        )} to ApplicationDbContextModelSnapshot.cs`
      );
    }

    if (content !== updatedContent || newFilePath !== filePath) {
      await fsExtra.writeFile(newFilePath, updatedContent);
      console.log(
        `✅ Fixed migration file: ${path.relative(targetPath, newFilePath)}`
      );
      console.log(
        `📄 Contents of ${path.relative(
          targetPath,
          newFilePath
        )} after fixing:`,
        updatedContent
      );

      // Remove original file if renamed
      if (newFilePath !== filePath) {
        await fsExtra.remove(filePath);
        console.log(
          `🗑 Removed original file: ${path.relative(targetPath, filePath)}`
        );
      }
    } else {
      console.log(
        `ℹ️ No changes needed in migration file: ${path.relative(
          targetPath,
          filePath
        )}`
      );
    }
  }

  // Clean up TempMigration subdirectory if it exists
  const tempMigrationPath = path.join(migrationsPath, "TempMigration");
  if (await fsExtra.pathExists(tempMigrationPath)) {
    await fsExtra.remove(tempMigrationPath);
    console.log("🗑 Removed TempMigration subdirectory");
  }
}

async function updateDotNetProject(sourcePath, targetPath, schemas, dbConfig) {
  console.log("🔄 Updating .NET project...");
  await fsExtra.copy(sourcePath, targetPath);

  const allEntities = schemas.map((s) => s.entity);
  const entitiesInMigrations = await getEntitiesInMigrations(targetPath);
  console.log(
    `Entities already in migrations: ${entitiesInMigrations.join(", ")}`
  );

  const newEntities = allEntities.filter(
    (entity) => !entitiesInMigrations.includes(entity)
  );
  const newSchemas = schemas.filter((s) => newEntities.includes(s.entity));

  console.log(`🆕 NEW entities to add: ${newEntities.join(", ")}`);
  console.log(
    `♻️ Existing entities (will be SKIPPED for migration): ${entitiesInMigrations.join(
      ", "
    )}`
  );

  if (newEntities.length === 0) {
    console.log(
      "ℹ️ No new entities to add. All entities already exist in migrations."
    );
    await updateDotNetProgram(targetPath, allEntities, dbConfig);

    const appsettingsPath = path.join(targetPath, "appsettings.json");
    await fsExtra.outputFile(
      appsettingsPath,
      generateDotNetAppSettings(dbConfig)
    );
    console.log("✅ appsettings.json updated");
    return;
  }

  for (const schema of newSchemas) {
    const entity = schema.entity;
    console.log(`📝 Generating files for NEW entity: ${entity}`);

    const modelPath = path.join(targetPath, "Models", `${entity}.cs`);
    await fsExtra.outputFile(
      modelPath,
      generateDotNetModel(entity, schema.fields)
    );
    console.log(`✅ Generated Models/${entity}.cs`);

    const controllerPath = path.join(
      targetPath,
      "Controllers",
      `${entity}Controller.cs`
    );
    await fsExtra.outputFile(
      controllerPath,
      generateDotNetController(entity, schema.fields)
    );
    console.log(`✅ Generated Controllers/${entity}Controller.cs`);
  }

  // Clean up existing problematic migration files
  const tempMigrationPath = path.join(
    targetPath,
    "Migrations",
    "TempApplicationDb"
  );
  if (await fsExtra.pathExists(tempMigrationPath)) {
    console.log("🧹 Cleaning up old TempApplicationDb migration files...");
    await fsExtra.remove(tempMigrationPath);
  }

  // Save the original DbContext (with all entities) for runtime
  await updateDotnetDbContextIncremental(targetPath, allEntities);

  // Generate a temporary DbContext with only new entities for migration
  const dbContextPath = path.join(
    targetPath,
    "Data",
    "ApplicationDbContext.cs"
  );
  const tempDbContextPath = path.join(
    targetPath,
    "Data",
    "TempMigrationContext.cs"
  );

  // Create temp context with different class name
  await fsExtra.outputFile(
    tempDbContextPath,
    generateTempMigrationContext(newEntities, dbConfig)
  );
  console.log("✅ Generated temporary TempMigrationContext.cs for migration");

  const dbContextFactoryPath = path.join(
    targetPath,
    "Data",
    "TempMigrationContextFactory.cs"
  );
  await fsExtra.outputFile(
    dbContextFactoryPath,
    generateTempMigrationContextFactory(dbConfig)
  );
  console.log("✅ Generated Data/TempMigrationContextFactory.cs");

  await updateDotNetProgram(targetPath, allEntities, dbConfig);

  const appsettingsPath = path.join(targetPath, "appsettings.json");
  await fsExtra.outputFile(
    appsettingsPath,
    generateDotNetAppSettings(dbConfig)
  );
  console.log("✅ appsettings.json updated");

  const csprojPath = path.join(targetPath, "DotNetApi.csproj");
  await fsExtra.outputFile(csprojPath, generateDotNetCsproj());
  console.log("✅ DotNetApi.csproj updated");

  if (newEntities.length > 0) {
    console.log(
      `🚀 Running 'dotnet ef migrations add' for new entities: ${newEntities.join(
        ", "
      )}`
    );

    // Clean up any existing ApplicationDbContextFactory.cs with wrong references
    const existingFactoryPath = path.join(
      targetPath,
      "Data",
      "ApplicationDbContextFactory.cs"
    );
    if (await fsExtra.pathExists(existingFactoryPath)) {
      await fsExtra.remove(existingFactoryPath);
      console.log("🧹 Cleaned up existing ApplicationDbContextFactory.cs");
    }

    try {
      console.log("🔨 Running dotnet build...");
      execSync("dotnet build", { cwd: targetPath, stdio: "inherit" });
      console.log("✅ Build successful");
    } catch (buildError) {
      console.error("❌ Build failed:", buildError);
      throw new Error(`Build failed: ${buildError.message}`);
    }

    const migrationName = `Add${newEntities
      .map((e) => e.charAt(0).toUpperCase() + e.slice(1))
      .join("And")}Entities`;

    try {
      console.log(
        `🛠 Running: dotnet ef migrations add ${migrationName} --context TempMigrationContext --output-dir Migrations`
      );
      execSync(
        `dotnet ef migrations add "${migrationName}" --context TempMigrationContext --output-dir Migrations`,
        {
          cwd: targetPath,
          stdio: "inherit",
          env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
        }
      );
      console.log(`✅ Migration generated: ${migrationName}`);
    } catch (migError) {
      console.error("❌ Migration generation failed:", migError);
      throw new Error(`Migration failed: ${migError.message}`);
    }

    // // Clean up temporary files after migration
    // await fsExtra.remove(tempDbContextPath);
    // await fsExtra.remove(dbContextFactoryPath);
    // console.log("✅ Cleaned up temporary migration context files");

    // Fix the generated migration files to use ApplicationDbContext
    await fixMigrationFiles(targetPath, migrationName); // Clean up temporary files after migration
    if (await fsExtra.pathExists(tempDbContextPath)) {
      await fsExtra.remove(tempDbContextPath);
      console.log("✅ Removed temporary TempMigrationContext.cs");
    }
    if (await fsExtra.pathExists(dbContextFactoryPath)) {
      await fsExtra.remove(dbContextFactoryPath);
      console.log("✅ Removed temporary TempMigrationContextFactory.cs");
    }
  } else {
    console.log("ℹ️ No new entities to migrate, skipping migration generation");
  }

  // Restore the proper ApplicationDbContextFactory
  const finalFactoryPath = path.join(
    targetPath,
    "Data",
    "ApplicationDbContextFactory.cs"
  );
  await fsExtra.outputFile(
    finalFactoryPath,
    generateDotNetDbContextFactory(dbConfig)
  );
  console.log("✅ Generated final ApplicationDbContextFactory.cs");

  const readmePath = path.join(targetPath, "README.md");
  await fsExtra.outputFile(
    readmePath,
    generateDotNetReadme(allEntities, dbConfig)
  );
  console.log("✅ README.md updated");

  console.log("✅ .NET project updated successfully");
}
async function getEntitiesInMigrations(targetPath) {
  const migrationsPath = path.join(targetPath, "Migrations");
  if (!(await fsExtra.pathExists(migrationsPath))) {
    console.log("ℹ️ No Migrations folder found");
    return [];
  }

  const files = await fsExtra.readdir(migrationsPath);
  const migrationFiles = files.filter(
    (file) =>
      file.endsWith(".cs") &&
      !file.includes("Designer") &&
      !file.includes("Snapshot")
  );

  const entities = new Set();
  migrationFiles.sort();

  for (const file of migrationFiles) {
    try {
      const content = await fsExtra.readFile(
        path.join(migrationsPath, file),
        "utf8"
      );

      const createTableMatches =
        content.match(/migrationBuilder\.CreateTable\(\s*name:\s*"(\w+)"/g) ||
        [];

      createTableMatches.forEach((match) => {
        const tableNameMatch = match.match(/name:\s*"(\w+)"/);
        if (tableNameMatch) {
          const tableName = tableNameMatch[1];
          const entityName = tableName.endsWith("s")
            ? tableName.slice(0, -1)
            : tableName;
          entities.add(entityName);
          console.log(
            `✅ Found entity in migration: ${entityName} (from table: ${tableName})`
          );
        }
      });

      const dropTableMatches =
        content.match(/migrationBuilder\.DropTable\(\s*name:\s*"(\w+)"/g) || [];

      dropTableMatches.forEach((match) => {
        const tableNameMatch = match.match(/name:\s*"(\w+)"/);
        if (tableNameMatch) {
          const tableName = tableNameMatch[1];
          const entityName = tableName.endsWith("s")
            ? tableName.slice(0, -1)
            : tableName;
          entities.delete(entityName);
          console.log(
            `❌ Removed entity from tracking: ${entityName} (dropped table: ${tableName})`
          );
        }
      });
    } catch (error) {
      console.error(`Error reading migration file ${file}:`, error);
    }
  }

  const result = Array.from(entities);
  console.log("📋 Final entities found in existing migrations:", result);
  return result;
}

function generateDotNetDbContextFactory(dbConfig) {
  console.log(
    "📋 Generating ApplicationDbContextFactory with dbConfig:",
    dbConfig
  );

  if (!dbConfig || !dbConfig.connectionString || !dbConfig.dbName) {
    console.error("⚠️ Invalid dbConfig:", dbConfig);
    throw new Error("Missing connectionString or dbName in dbConfig");
  }

  const server = dbConfig.connectionString;
  const dbName = dbConfig.dbName;
  const baseConn = `Server=${server};Database=${dbName};`;
  let connectionString;
  if (dbConfig.useAuth) {
    if (!dbConfig.username || !dbConfig.password) {
      console.error(
        "⚠️ Missing username or password for auth-enabled dbConfig"
      );
      throw new Error("Username and password required when useAuth is true");
    }
    connectionString = `${baseConn}User Id=${dbConfig.username};Password=${dbConfig.password};TrustServerCertificate=True;MultipleActiveResultSets=true;`;
  } else {
    connectionString = `${baseConn}Trusted_Connection=True;TrustServerCertificate=True;MultipleActiveResultSets=true;`;
  }

  const escapedConnectionString = connectionString.replace(/\\/g, "\\\\");

  return `// Data/ApplicationDbContextFactory.cs
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using DotNetApi.Data;

namespace DotNetApi.Data;

public class ApplicationDbContextFactory : IDesignTimeDbContextFactory<ApplicationDbContext>
{
    public ApplicationDbContext CreateDbContext(string[] args)
    {
        var optionsBuilder = new DbContextOptionsBuilder<ApplicationDbContext>();
        optionsBuilder.UseSqlServer("${escapedConnectionString}");
        return new ApplicationDbContext(optionsBuilder.Options);
    }
}
`;
}
function generateTemporaryDotNetDbContext(entities) {
  const entityConfigs = entities
    .map((entity) => `public DbSet<${entity}> ${entity}s { get; set; }`)
    .join("\n    ");

  return `// Data/ApplicationDbContext_Temp.cs
using Microsoft.EntityFrameworkCore;
using DotNetApi.Models;

namespace DotNetApi.Data;

public class ApplicationDbContext : DbContext
{
    public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options) : base(options)
    {
    }

    ${entityConfigs}
}
`;
}

async function updateDotnetDbContextIncremental(projectPath, entities) {
  const dbContextPath = path.join(
    projectPath,
    "Data",
    "ApplicationDbContext.cs"
  );

  if (!(await fsExtra.pathExists(dbContextPath))) {
    console.warn("ApplicationDbContext.cs not found, creating new one");
    await fsExtra.outputFile(dbContextPath, generateDotNetDbContext(entities));
    console.log("✅ ApplicationDbContext.cs created");
    return;
  }

  let dbContextContent = await fsExtra.readFile(dbContextPath, "utf8");

  for (const entity of entities) {
    const dbSetLine = `public DbSet<${entity}> ${entity}s { get; set; }`;
    if (!dbContextContent.includes(dbSetLine)) {
      const insertIndex = dbContextContent.lastIndexOf("}");
      dbContextContent =
        dbContextContent.slice(0, insertIndex) +
        `    ${dbSetLine}\n` +
        dbContextContent.slice(insertIndex);
      console.log(`✅ Added DbSet for entity: ${entity}`);
    }
  }

  await fsExtra.outputFile(dbContextPath, dbContextContent);
  console.log(
    "✅ ApplicationDbContext.cs updated incrementally with all entities"
  );
}

function parseNaturalLanguage(description) {
  const schemas = [];
  const entityRegex = /Create a (\w+) API with ([^.]+)(?:\.|$)/gi;
  let entityMatch;

  while ((entityMatch = entityRegex.exec(description)) !== null) {
    const entityName = entityMatch[1];
    let fieldsStr = entityMatch[2].trim();

    fieldsStr = fieldsStr.replace(/\.$/, "");
    fieldsStr = fieldsStr.replace(/\band\s+/gi, ", ");

    const fields = [];
    const fieldRegex = /(\w+)\s+as\s+(\w+)(\s+required)?(?:,|$)/gi;
    let match;

    while ((match = fieldRegex.exec(fieldsStr)) !== null) {
      const [, name, type, requiredStr] = match;
      const required = !!requiredStr;
      const normalizedType = type.toLowerCase();

      if (
        !["string", "number", "boolean", "date", "array"].includes(
          normalizedType
        )
      ) {
        throw new Error(
          `Invalid field type "${type}" for field "${name}". Use: string, number, boolean, date, array`
        );
      }

      fields.push({ name, type: normalizedType, required });
    }

    if (fields.length === 0) {
      throw new Error(
        `No valid fields found in description for entity "${entityName}". Check format: "fieldName as type [required]"`
      );
    }

    schemas.push({ entity: entityName, fields });
  }

  if (schemas.length === 0) {
    throw new Error(
      'Invalid format. Use: "Create [Entity] API with [field as type, ...]"'
    );
  }

  return schemas;
}

function generateNodeJSServer(
  entities,
  dbConfig,
  isUpdate = false,
  framework = "nodejs"
) {
  const imports = entities
    .map((entity) => `const ${entity}Routes = require('./routes/${entity}');`)
    .join("\n");

  const routes = entities
    .map((entity) => {
      const lowerEntity = entity.toLowerCase();
      return `app.use('/api/${lowerEntity}s', ${entity}Routes);`;
    })
    .join("\n");

  const endpoints = entities
    .map((entity) => `'${entity.toLowerCase()}s'`)
    .sort()
    .map((endpoint) => `'${endpoint}'`)
    .join(", ");

  return `// server.js
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const net = require('net');
const connectDB = require('./config/database');
${imports}

const app = express();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests from this IP, please try again later.' }
});
app.use(limiter);

function getAvailablePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(getAvailablePort(startPort + 1));
      } else {
        reject(err);
      }
    });
    server.listen(startPort, () => {
      server.close(() => {
        resolve(startPort);
      });
    });
  });
}

(async () => {
  try {
    const basePort = process.env.PORT || 3000;
    const PORT = await getAvailablePort(basePort);
    await connectDB();

    app.use(helmet());
    app.use(cors());
    app.use(morgan('combined'));
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true }));
    app.disable('x-powered-by');

    ${routes}

    app.get('/', async (req, res) => {
      try {
        const mongoose = require('mongoose');
        const dbStatus = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
        res.json({
          message: 'Node.js Multi API Server with MongoDB is running! (Secured with Helmet & Rate Limiting)',
          database: { status: dbStatus, name: '${dbConfig.dbName}' },
          endpoints: [${endpoints}],
          totalAPIs: ${entities.length},
          version: '1.0.0',
          ${isUpdate ? "lastUpdate: new Date().toISOString()," : ""}
        });
      } catch (error) {
        res.status(500).json({ error: 'Server health check failed' });
      }
    });

    app.use('*', (req, res) => {
      res.status(404).json({ error: 'Route not found' });
    });

    app.use((error, req, res, next) => {
      console.error('Server Error:', error);
      res.status(500).json({ error: 'Internal server error' });
    });

    app.listen(PORT, () => {
      console.log(\`🚀 Server running on port \${PORT}\`);
      console.log(\`📋 Available endpoints (\${${entities.length} APIs):\`);
      ${entities
        .map(
          (entity) =>
            `console.log(\`  - http://localhost:\${PORT}/api/${entity.toLowerCase()}s\`);`
        )
        .join("\n  ")}
      console.log(\`  - http://localhost:\${PORT}/ (health check)\`);
      console.log('🔒 Security: Helmet, Rate Limiting, and Input Validation enabled');
      ${isUpdate ? 'console.log("✨ APIs updated successfully!");' : ""}
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();
`;
}

function generateNodeJSConfig(dbConfig) {
  const { dbName, connectionString, useAuth, username, password } = dbConfig;
  const connStr = useAuth
    ? `${connectionString}/${dbName}?authSource=admin`
    : `${connectionString}/${dbName}`;

  return `// config/database.js
const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    await mongoose.connect('${connStr}', {
      ${useAuth ? `user: '${username}', pass: '${password}',` : ""}
    });
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

module.exports = connectDB;
`;
}

function generateNodeJSModel(entity, fields) {
  const schemaFields = fields
    .map((field) => {
      const typeMap = {
        string: "String",
        number: "Number",
        boolean: "Boolean",
        date: "Date",
        array: "[String]",
      };
      return `    ${field.name}: { type: ${typeMap[field.type]}, ${
        field.required ? "required: true" : ""
      } }`;
    })
    .join(",\n");

  return `// models/${entity}.js
const mongoose = require('mongoose');

const ${entity}Schema = new mongoose.Schema({
${schemaFields}
}, { timestamps: true });

module.exports = mongoose.model('${entity}', ${entity}Schema);
`;
}

function generateNodeJSController(entity, fields) {
  return `// controllers/${entity}Controller.js
const ${entity} = require('../models/${entity}');

exports.getAll${entity}s = async () => {
  try {
    const items = await ${entity}.find();
    return { items, total: items.length };
  } catch (error) {
    throw new Error('Failed to fetch ${entity}s');
  }
};

exports.get${entity}ById = async (id) => {
  try {
    const item = await ${entity}.findById(id);
    if (!item) {
      throw new Error('${entity} not found');
    }
    return item;
  } catch (error) {
    throw error.message === '${entity} not found' ? error : new Error('Failed to fetch ${entity}');
  }
};

exports.create${entity} = async (data) => {
  try {
    const item = new ${entity}(data);
    await item.save();
    return item;
  } catch (error) {
    throw new Error('Failed to create ${entity}');
  }
};

exports.update${entity} = async (id, data) => {
  try {
    const item = await ${entity}.findByIdAndUpdate(id, data, { new: true });
    if (!item) {
      throw new Error('${entity} not found');
    }
    return item;
  } catch (error) {
    throw error.message === '${entity} not found' ? error : new Error('Failed to update ${entity}');
  }
};

exports.delete${entity} = async (id) => {
  try {
    const item = await ${entity}.findByIdAndDelete(id);
    if (!item) {
      throw new Error('${entity} not found');
    }
    return { message: '${entity} deleted' };
  } catch (error) {
    throw error.message === '${entity} not found' ? error : new Error('Failed to delete ${entity}');
  }
};
`;
}

function generateNodeJSRoute(entity, fields) {
  const lowerEntity = entity.toLowerCase();
  const validations = fields
    .map((field) => {
      let validation = `body('${field.name}')`;
      if (field.required)
        validation += `.notEmpty().withMessage('${field.name} is required')`;
      if (field.type === "string") validation += `.trim().escape()`;
      if (field.type === "number")
        validation += `.isNumeric().withMessage('${field.name} must be a number')`;
      if (field.type === "boolean")
        validation += `.isBoolean().withMessage('${field.name} must be a boolean')`;
      if (field.type === "date")
        validation += `.isISO8601().withMessage('${field.name} must be a valid date')`;
      return validation;
    })
    .join(",\n      ");

  return `// routes/${entity}.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const ${entity}Controller = require('../controllers/${entity}Controller');

router.get('/', async (req, res) => {
  try {
    const { items, total } = await ${entity}Controller.getAll${entity}s();
    res.set('X-Total-Count', total);
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const item = await ${entity}Controller.get${entity}ById(req.params.id);
    res.json(item);
  } catch (error) {
    res.status(error.message === '${entity} not found' ? 404 : 500).json({ error: error.message });
  }
});

router.post('/', [
  ${validations}
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const item = await ${entity}Controller.create${entity}(req.body);
    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', [
  ${validations}
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    const item = await ${entity}Controller.update${entity}(req.params.id, req.body);
    res.json(item);
  } catch (error) {
    res.status(error.message === '${entity} not found' ? 404 : 500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await ${entity}Controller.delete${entity}(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(error.message === '${entity} not found' ? 404 : 500).json({ error: error.message });
  }
});

module.exports = router;
`;
}

function generateNodeJSReadme(entities, dbConfig, framework = "nodejs") {
  const portInfo =
    framework === "both"
      ? "\n### Port Configuration\n- Node.js server: http://localhost:3000\n- .NET server: http://localhost:5000\n"
      : "";

  return `# Node.js + MongoDB API Project
${portInfo}

## 🚀 Getting Started

This is a Node.js API project with MongoDB, generated automatically. It includes secure RESTful APIs with Helmet, rate limiting, and input validation, using a controller-based architecture.

### Prerequisites
- Node.js (v20 or higher)
- MongoDB (running at \`${dbConfig.connectionString}\`)

### Setup
1. Install dependencies:
   \`\`\`bash
   npm install
   \`\`\`
2. Start MongoDB server.
3. Run the server:
   \`\`\`bash
   npm start
   \`\`\`

### Project Structure
- **server.js**: Entry point, sets up Express and middleware.
- **config/**: Database connection setup.
- **models/**: Mongoose schemas for entities.
- **controllers/**: Business logic for CRUD operations.
- **routes/**: Express routes with input validation.

### Endpoints
${entities
  .map(
    (entity) =>
      `- **${entity} API**: \`/api/${entity.toLowerCase()}s\` (CRUD operations)`
  )
  .join("\n")}

- Health check: \`/ (GET)\`

### 🔒 Security Features
- **Helmet**: Secure HTTP headers (CSP, XSS protection)
- **Rate Limiting**: 100 requests/15min per IP (DDoS mitigation)
- **Input Validation**: express-validator sanitizes inputs
- **OWASP Compliance**: Follows [Node.js Security Checklist](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html)

### Example
\`\`\`bash
curl http://localhost:3000/api/users
\`\`\`
`;
}

function generateNodeJSPackageJson(entities) {
  return `{
  "name": "nodejs-mongodb-api",
  "version": "1.0.0",
  "description": "Generated Node.js API with MongoDB",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.0",
    "mongoose": "^7.5.0",
    "cors": "^2.8.5",
    "morgan": "^1.10.0",
    "dotenv": "^16.3.1",
    "helmet": "^7.1.0",
    "express-rate-limit": "^7.4.0",
    "express-validator": "^7.2.0"
  }
}`;
}

function generateDotNetLaunchSettings() {
  return `{
  "profiles": {
    "http": {
      "commandName": "Project",
      "dotnetRunMessages": true,
      "launchBrowser": true,
      "launchUrl": "swagger",
      "applicationUrl": "http://localhost:5000",
      "environmentVariables": {
        "ASPNETCORE_ENVIRONMENT": "Development"
      }
    },
    "https": {
      "commandName": "Project",
      "dotnetRunMessages": true,
      "launchBrowser": true,
      "launchUrl": "swagger",
      "applicationUrl": "https://localhost:7000;http://localhost:5000",
      "environmentVariables": {
        "ASPNETCORE_ENVIRONMENT": "Development"
      }
    }
  }
}`;
}

function generateDotNetProgram(entities, dbConfig) {
  return `// Program.cs
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.EntityFrameworkCore;
using DotNetApi.Data;
using System.Net;
using System.Net.Sockets;
using AspNetCoreRateLimit;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen();

builder.Services.AddCors(options =>
{
    options.AddPolicy("SecureCors", policy =>
    {
        policy.WithOrigins("https://localhost:3000")
              .AllowAnyMethod()
              .AllowAnyHeader()
              .WithExposedHeaders("X-Total-Count");
    });
});

builder.Services.AddMemoryCache();
builder.Services.Configure<IpRateLimitOptions>(builder.Configuration.GetSection("IpRateLimiting"));
builder.Services.Configure<IpRateLimitPolicies>(builder.Configuration.GetSection("IpRateLimitPolicies"));
builder.Services.AddInMemoryRateLimiting();
builder.Services.AddSingleton<IRateLimitConfiguration, RateLimitConfiguration>();

builder.Services.AddDbContext<ApplicationDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection")));

var app = builder.Build();

int GetAvailablePort(int startPort)
{
    while (true)
    {
        try
        {
            var listener = new TcpListener(IPAddress.Loopback, startPort);
            listener.Start();
            listener.Stop();
            return startPort;
        }
        catch (SocketException)
        {
            startPort++;
        }
    }
}

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseCors("SecureCors");

app.UseIpRateLimiting();
app.UseAuthorization();

app.MapControllers();

app.MapGet("/", async (ApplicationDbContext db) => {
    var connected = await db.Database.CanConnectAsync();
    var dbStatus = connected ? "Connected" : "Disconnected";
    return new
    {
        Message = ".NET Core Multi API Server with SQL Server is running! (Secured with Rate Limiting & Tight CORS)",
        Database = new { Status = dbStatus, Name = "${dbConfig.dbName}" },
        Endpoints = new[] { ${entities
          .map((entity) => `"/api/${entity}s"`)
          .join(", ")} },
        TotalAPIs = ${entities.length},
        Version = "1.0.0"
    };
});

int basePort = 5000;
int port = GetAvailablePort(basePort);
app.Run($"http://localhost:{port}");
`;
}

function generateDotNetDbContext(entities) {
  const entityConfigs = entities
    .map((entity) => `public DbSet<${entity}> ${entity}s { get; set; }`)
    .join("\n    ");

  return `// Data/ApplicationDbContext.cs
using Microsoft.EntityFrameworkCore;
using DotNetApi.Models;

namespace DotNetApi.Data;

public class ApplicationDbContext : DbContext
{
    public ApplicationDbContext(DbContextOptions<ApplicationDbContext> options) : base(options)
    {
    }

    ${entityConfigs}
}
`;
}

function generateDotNetModel(entity, fields) {
  const csTypeMap = {
    string: "string",
    number: "double",
    boolean: "bool",
    date: "DateTime",
  };

  const properties = fields
    .map((field) => {
      const raw = csTypeMap[field.type] || "string";
      const isRefType = raw === "string";
      const nullableMark = field.required ? "" : "?";
      const requiredKeyword = field.required && isRefType ? "required " : "";
      const propName = field.name.charAt(0).toUpperCase() + field.name.slice(1);
      return `public ${requiredKeyword}${raw}${nullableMark} ${propName} { get; set; }`;
    })
    .join("\n    ");

  return `// Models/${entity}.cs
using System;

namespace DotNetApi.Models;

public class ${entity}
{
    public int Id { get; set; }
    ${properties}
    public DateTime? CreatedAt { get; set; }
    public DateTime? UpdatedAt { get; set; }
}
`;
}

function generateDotNetController(entity, fields) {
  const entityPlural = `${entity}s`;
  const entityLower = entity.toLowerCase();
  const entityPascal = entity.charAt(0).toUpperCase() + entity.slice(1);

  return `// Controllers/${entity}Controller.cs
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using DotNetApi.Data;
using DotNetApi.Models;
using System.Linq;
using System.Threading.Tasks;

namespace DotNetApi.Controllers;

[Route("api/[controller]")]
[ApiController]
public class ${entity}Controller : ControllerBase
{
    private readonly ApplicationDbContext _context;

    public ${entity}Controller(ApplicationDbContext context)
    {
        _context = context;
    }

    [HttpGet]
    public async Task<IActionResult> Get${entityPlural}()
    {
        var items = await _context.${entityPlural}.ToListAsync();
        Response.Headers["X-Total-Count"] = items.Count.ToString();
        return Ok(items);
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Get${entity}(int id)
    {
        var ${entityLower} = await _context.${entityPlural}.FindAsync(id);
        if (${entityLower} == null)
        {
            return NotFound();
        }
        return Ok(${entityLower});
    }

    [HttpPost]
    public async Task<IActionResult> Post${entity}([FromBody] ${entityPascal} ${entityLower})
    {
        ${entityLower}.CreatedAt = DateTime.UtcNow;
        _context.${entityPlural}.Add(${entityLower});
        await _context.SaveChangesAsync();
        return CreatedAtAction(nameof(Get${entity}), new { id = ${entityLower}.Id }, ${entityLower});
    }

    [HttpPut("{id}")]
    public async Task<IActionResult> Put${entity}(int id, [FromBody] ${entityPascal} ${entityLower})
    {
        if (id != ${entityLower}.Id)
        {
            return BadRequest();
        }
        ${entityLower}.UpdatedAt = DateTime.UtcNow;
        _context.Entry(${entityLower}).State = EntityState.Modified;
        try
        {
            await _context.SaveChangesAsync();
        }
        catch (DbUpdateConcurrencyException)
        {
            if (!${entityPascal}Exists(id))
            {
                return NotFound();
            }
            throw;
        }
        return NoContent();
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete${entity}(int id)
    {
        var ${entityLower} = await _context.${entityPlural}.FindAsync(id);
        if (${entityLower} == null)
        {
            return NotFound();
        }
        _context.${entityPlural}.Remove(${entityLower});
        await _context.SaveChangesAsync();
        return NoContent();
    }

    private bool ${entityPascal}Exists(int id)
    {
        return _context.${entityPlural}.Any(e => e.Id == id);
    }
}
`;
}

function generateDotNetAppSettings(dbConfig) {
  console.log(
    "📋 Generating appsettings.json with dbConfig:",
    JSON.stringify(dbConfig, null, 2)
  );
  if (!dbConfig || !dbConfig.connectionString || !dbConfig.dbName) {
    console.error("⚠️ Invalid dbConfig:", JSON.stringify(dbConfig, null, 2));
    throw new Error("Missing connectionString or dbName in dbConfig");
  }

  const server = dbConfig.connectionString;
  const dbName = dbConfig.dbName;
  const baseConn = `Server=${server};Database=${dbName};`;
  let connectionString;
  if (dbConfig.useAuth) {
    if (!dbConfig.username || !dbConfig.password) {
      console.error(
        "⚠️ Missing username or password for auth-enabled dbConfig"
      );
      throw new Error("Username and password required when useAuth is true");
    }
    connectionString = `${baseConn}User Id=${dbConfig.username};Password=${dbConfig.password};TrustServerCertificate=True;MultipleActiveResultSets=true;`;
  } else {
    connectionString = `${baseConn}Trusted_Connection=True;TrustServerCertificate=True;MultipleActiveResultSets=true;`;
  }

  const config = {
    ConnectionStrings: {
      DefaultConnection: connectionString,
    },
    IpRateLimiting: {
      EnableEndpointRateLimiting: true,
      StackBlockedRequests: false,
      HttpStatusCode: 429,
      GeneralRules: [
        {
          Endpoint: "*",
          Period: "15m",
          Limit: 100,
        },
      ],
    },
    Logging: {
      LogLevel: {
        Default: "Information",
        "Microsoft.EntityFrameworkCore": "Debug",
      },
    },
    AllowedHosts: "*",
  };

  return JSON.stringify(config, null, 2);
}

function generateDotNetCsproj() {
  return `<!-- DotNetApi.csproj -->
<Project Sdk="Microsoft.NET.Sdk.Web">

  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="8.0.8" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="8.0.8">
      <PrivateAssets>all</PrivateAssets>
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
    </PackageReference>
    <PackageReference Include="Swashbuckle.AspNetCore" Version="6.9.0" />
    <PackageReference Include="AspNetCoreRateLimit" Version="5.0.0" />
  </ItemGroup>

  <ItemGroup>
    <None Update="appsettings.json">
      <CopyToOutputDirectory>Always</CopyToOutputDirectory>
    </None>
  </ItemGroup>

</Project>`;
}

function generateDotNetReadme(entities, dbConfig, framework = "dotnet") {
  const portInfo =
    framework === "both"
      ? "\n### Port Configuration\n- .NET server: http://localhost:5000\n- Node.js server: http://localhost:3000\n"
      : "";

  return `# .NET Core + SQL Server API Project
${portInfo}
## 🚀 Getting Started

This is a .NET Core API project with SQL Server, generated automatically. It includes secure RESTful APIs with rate limiting and tight CORS.

### Prerequisites
- .NET 8 SDK
- SQL Server (running at \`${dbConfig.connectionString}\`)

### Setup
1. Restore dependencies:
   \`\`\`bash
   dotnet restore
   \`\`\`
2. **For existing projects**: Run incremental migration and update database:
   \`\`\`bash
   dotnet ef migrations add AddNewEntities
   dotnet ef database update
   \`\`\`
   
   **For new projects**: Add initial migration and update database:
   \`\`\`bash
   dotnet ef migrations add InitialCreate
   dotnet ef database update
   \`\`\`
3. Run the server:
   \`\`\`bash
   dotnet run
   \`\`\`

### ⚠️ Important Migration Notes
- If you get "table already exists" errors, check your existing migrations in the \`Migrations\` folder
- Use \`dotnet ef migrations list\` to see existing migrations
- Use \`dotnet ef database update\` to apply pending migrations
- Never run \`InitialCreate\` on an existing database with tables

### Endpoints
${entities
  .map((entity) => `- **${entity} API**: \`/api/${entity}s\` (CRUD operations)`)
  .join("\n")}

- Health check: \`/ (GET)\`
- Swagger UI: \`/swagger\`

### 🔒 Security Features
- **Tight CORS**: Configured for specific origins only
- **Rate Limiting**: 100 requests/15min per IP
- **Anti-Forgery**: Built-in for forms (extend for APIs)
- **OWASP Compliance**: Mitigates Top 10 risks

### 🐛 Troubleshooting
- **"Table already exists" error**: Delete the \`Migrations\` folder and recreate with \`dotnet ef migrations add InitialCreate\`
- **Migration conflicts**: Use \`dotnet ef migrations remove\` to remove the last migration
- **Database connection issues**: Check your connection string in \`appsettings.json\`

### Example
\`\`\`bash
curl http://localhost:5000/api/users
\`\`\`
`;
}

async function generateAndZipProject(payload, res) {
  const { framework, schemas, dbConfig, nodejsDbConfig, dotnetDbConfig } =
    payload;
  console.log("Payload in generateAndZipProject:", payload);
  if (
    framework === "dotnet" &&
    (!dbConfig || !dbConfig.connectionString || !dbConfig.dbName)
  ) {
    throw new Error(
      "Invalid dbConfig for .NET: Missing connectionString or dbName"
    );
  }
  if (!Array.isArray(schemas) || schemas.length === 0) {
    throw new Error("Invalid schemas: Must be a non-empty array");
  }

  const tempDir = path.join(__dirname, `temp-generate-${uuidv4()}`);
  const outputDir = path.join(tempDir, "project");
  const outputZipPath = path.join(
    tempDir,
    `generated-project-${framework}-${Date.now()}.zip`
  );

  try {
    await fsExtra.ensureDir(tempDir);
    await fsExtra.ensureDir(outputDir);

    const entities = schemas.map((s) => s.entity);

    if (framework === "both") {
      const nodejsPath = path.join(outputDir, "nodejs");
      const dotnetPath = path.join(outputDir, "dotnet");
      await fsExtra.ensureDir(nodejsPath);
      await fsExtra.ensureDir(dotnetPath);

      const nodeStructure = generateNodeJSAPI(
        entities,
        nodejsDbConfig,
        false,
        "both"
      );
      for (const [filePath, content] of Object.entries(nodeStructure)) {
        if (typeof content === "object") {
          for (const [subPath, subContent] of Object.entries(content)) {
            await fsExtra.outputFile(
              path.join(nodejsPath, filePath, subPath),
              subContent
            );
          }
        } else {
          await fsExtra.outputFile(path.join(nodejsPath, filePath), content);
        }
      }

      const dotnetStructure = generateDotNetAPI(
        entities,
        dotnetDbConfig,
        schemas, // Pass schemas explicitly
        false,
        "both"
      );
      for (const [filePath, content] of Object.entries(dotnetStructure)) {
        if (typeof content === "object") {
          for (const [subPath, subContent] of Object.entries(content)) {
            await fsExtra.outputFile(
              path.join(dotnetPath, filePath, subPath),
              subContent
            );
          }
        } else {
          await fsExtra.outputFile(path.join(dotnetPath, filePath), content);
        }
      }
    } else if (framework === "nodejs") {
      const structure = generateNodeJSAPI(entities, dbConfig);
      for (const [filePath, content] of Object.entries(structure)) {
        if (typeof content === "object") {
          for (const [subPath, subContent] of Object.entries(content)) {
            await fsExtra.outputFile(
              path.join(outputDir, filePath, subPath),
              subContent
            );
          }
        } else {
          await fsExtra.outputFile(path.join(outputDir, filePath), content);
        }
      }
    } else if (framework === "dotnet") {
      const structure = generateDotNetAPI(entities, dbConfig, schemas); // Pass schemas explicitly
      for (const [filePath, content] of Object.entries(structure)) {
        if (typeof content === "object") {
          for (const [subPath, subContent] of Object.entries(content)) {
            await fsExtra.outputFile(
              path.join(outputDir, filePath, subPath),
              subContent
            );
          }
        } else {
          await fsExtra.outputFile(path.join(outputDir, filePath), content);
        }
      }
    }

    const output = fsExtra.createWriteStream(outputZipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (err) => {
      throw new Error("Failed to create ZIP file");
    });

    archive.pipe(output);
    archive.directory(outputDir, false);

    await new Promise((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
      archive.finalize();
    });

    res.download(outputZipPath, path.basename(outputZipPath), async (err) => {
      if (err) {
        res.status(500).json({ error: "Failed to send generated project" });
      }
      await fsExtra.remove(tempDir);
    });
  } catch (error) {
    console.error("Generation error:", error);
    await fsExtra.remove(tempDir);
    res.status(500).json({ error: `Generation failed: ${error.message}` });
  }
}

// Start the server
function generateNodeJSAPI(
  entities,
  dbConfig,
  schemas, // Add schemas parameter
  isUpdate = false,
  framework = "nodejs"
) {
  const structure = {
    "server.js": generateNodeJSServer(entities, dbConfig, isUpdate, framework),
    "config/database.js": generateNodeJSConfig(dbConfig),
    "package.json": generateNodeJSPackageJson(entities),
    "README.md": generateNodeJSReadme(entities, dbConfig, framework),
    models: {},
    routes: {},
    controllers: {},
  };

  entities.forEach((entity) => {
    const entitySchema = schemas.find((s) => s.entity === entity);
    if (!entitySchema) {
      throw new Error(`Schema not found for entity: ${entity}`);
    }
    structure.models[`${entity}.js`] = generateNodeJSModel(
      entity,
      entitySchema.fields
    );
    structure.routes[`${entity}.js`] = generateNodeJSRoute(
      entity,
      entitySchema.fields
    );
    structure.controllers[`${entity}Controller.js`] = generateNodeJSController(
      entity,
      entitySchema.fields
    );
  });

  return structure;
}
function generateDotNetAPI(
  entities,
  dbConfig,
  schemas, // Add schemas parameter
  isUpdate = false,
  framework = "dotnet"
) {
  console.log("Generating .NET API with schemas:", schemas);
  const structure = {
    "Properties/launchSettings.json": generateDotNetLaunchSettings(),
    "Program.cs": generateDotNetProgram(entities, dbConfig),
    "appsettings.json": generateDotNetAppSettings(dbConfig),
    "DotNetApi.csproj": generateDotNetCsproj(),
    "Data/ApplicationDbContext.cs": generateDotNetDbContext(entities),
    "Data/ApplicationDbContextFactory.cs":
      generateDotNetDbContextFactory(dbConfig),
    "README.md": generateDotNetReadme(entities, dbConfig, framework),
    Models: {},
    Controllers: {},
  };

  entities.forEach((entity) => {
    const entitySchema = schemas.find((s) => s.entity === entity);
    if (!entitySchema) {
      throw new Error(`Schema not found for entity: ${entity}`);
    }
    structure.Models[`${entity}.cs`] = generateDotNetModel(
      entity,
      entitySchema.fields
    );
    structure.Controllers[`${entity}Controller.cs`] = generateDotNetController(
      entity,
      entitySchema.fields
    );
  });

  return structure;
}
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port on http://localhost:${PORT}`);
  console.log("📋 Available endpoints:");
  console.log("  - POST /parse-ai");
  console.log("  - POST /generate");
  console.log("  - POST /update-project");
});
