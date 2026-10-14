using Microsoft.Extensions.FileProviders;
using PiwiTests.Instrumentation.AspNetCore;
using SampleApp;
using SampleApp.Endpoints;
using SampleApp.Services;

var builder = WebApplication.CreateBuilder(args);

// Backend logs: the Warning, Error and Critical entries each request logs, for the middleware below.
builder.AddPiwiTestLogs();

builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<UnhandledExceptionHandler>();
builder.Services.AddSingleton<PriceFeed>();
builder.Services.AddSingleton<InventoryService>();
builder.Services.AddSingleton<UserDirectory>();
builder.Services.AddSingleton<ProductCatalog>();
builder.Services.AddSingleton<OrderService>();

// The frontend every backend serves: examples/sample-app/web, two levels above this project.
var web = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "..", "..", "web"));
builder.Services.AddSingleton(new PageFiles(Path.Combine(web, "pages")));

var app = builder.Build();

// First in the pipeline, so it wraps every request: the X-Piwi-Logs header, the route manifest at /__piwi/manifest,
// the server probes (PIWI_PROBE_SECRET, PIWI_SERVER_PROBES) and, in a coverage build (-p:PiwiCoverage=true), the
// X-Piwi-Coverage header and the /__piwi/coverage endpoints. Active in the Development and Test environments.
app.UsePiwiTestLogs();

// Inside the Piwi middleware: UnhandledExceptionHandler logs an unhandled exception before its 500 response starts.
app.UseExceptionHandler();

app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(Path.Combine(web, "assets")),
    RequestPath = "/assets",
});

app.MapPages();
app.MapDemoApi();
app.MapShopApi();

app.Run();
