namespace Acme.Core;

public partial class Report
{
    private readonly IGreeter greeter;

    public Report(IGreeter greeter)
    {
        this.greeter = greeter;
    }

    public string Render(string name)
    {
        return Header() + greeter.Greet(name);
    }
}
