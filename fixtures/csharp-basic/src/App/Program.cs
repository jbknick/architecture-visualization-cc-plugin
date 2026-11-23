using Acme.Core;
using static Acme.Core.Strings;

namespace Acme.App;

public static class Program
{
    public static void Main()
    {
        Run(new PoliteGreeter(), "world");
    }

    public static string Run(IGreeter greeter, string name)
    {
        string text = Shout(name);
        string both = text.Twice();
        var report = new Report(greeter);
        return report.Render(both) + greeter.Greet(name);
    }
}
