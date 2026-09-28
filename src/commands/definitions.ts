import {
  SlashCommandBuilder,
  ChannelType,
  type SlashCommandSubcommandBuilder,
} from "discord.js";
// Values match sourceChoices in src/config/preferences.ts.
const sources = (s: SlashCommandSubcommandBuilder) =>
  s.addStringOption((o) =>
    o
      .setName("sources")
      .setDescription("Where to search (default: both)")
      .addChoices(
        { name: "eBay + Facebook Marketplace", value: "both" },
        { name: "eBay only", value: "ebay_only" },
        { name: "Facebook Marketplace only", value: "facebook_only" },
      ),
  );
export const commands = [
  new SlashCommandBuilder()
    .setName("defaults")
    .setDescription(
      "Set your city or ZIP, radius in miles, and pickup/shipping; omit options to view",
    )
    .setDMPermission(false)
    .addStringOption((o) =>
      o
        .setName("city")
        .setDescription("US city and state, e.g. Portland, OR")
        .setMaxLength(100),
    )
    .addStringOption((o) =>
      o
        .setName("zipcode")
        .setDescription("Five-digit US ZIP code")
        .setMinLength(5)
        .setMaxLength(5),
    )
    .addIntegerOption((o) =>
      o
        .setName("radius")
        .setDescription("Search radius in miles (1–100)")
        .setMinValue(1)
        .setMaxValue(100),
    )
    .addStringOption((o) =>
      o
        .setName("delivery")
        .setDescription("Pickup, shipping, or either")
        .addChoices(
          { name: "Pickup", value: "pickup" },
          { name: "Shipping", value: "shipping" },
          { name: "Either", value: "either" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("watch")
    .setDescription("Create and manage your keyword watches")
    .setDMPermission(false)
    .addSubcommand((s) =>
      sources(
        s
          .setName("create")
          .setDescription("Preview a natural-language keyword watch")
          .addStringOption((o) =>
            o
              .setName("query")
              .setDescription("e.g. wireless gaming mice under $80")
              .setRequired(true)
              .setMaxLength(2000),
          )
          .addChannelOption((o) =>
            o
              .setName("channel")
              .setDescription("Alert destination (default: here)")
              .addChannelTypes(ChannelType.GuildText),
          ),
      ),
    )
    .addSubcommand((s) => s.setName("list").setDescription("List your watches"))
    .addSubcommand((s) =>
      sources(
        s
          .setName("update")
          .setDescription(
            "Replace keywords/filters; unstated sources, area and price limits are kept",
          )
          .addStringOption((o) =>
            o.setName("id").setDescription("Watch ID").setRequired(true),
          )
          .addStringOption((o) =>
            o
              .setName("query")
              .setDescription("Complete replacement search criteria")
              .setRequired(true)
              .setMaxLength(2000),
          ),
      ),
    )
    .addSubcommand((s) =>
      s
        .setName("pause")
        .setDescription("Pause a watch")
        .addStringOption((o) =>
          o.setName("id").setDescription("Watch ID").setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("resume")
        .setDescription("Resume a watch")
        .addStringOption((o) =>
          o.setName("id").setDescription("Watch ID").setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("delete")
        .setDescription("Delete a watch and its alert history")
        .addStringOption((o) =>
          o.setName("id").setDescription("Watch ID").setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName("listing")
    .setDescription("Review saved alerts")
    .setDMPermission(false)
    .addSubcommand((s) =>
      s.setName("saved").setDescription("Retrieve alerts you saved for later"),
    )
    .addSubcommand((s) =>
      s
        .setName("details")
        .setDescription("Download a saved alert's full details")
        .addStringOption((o) =>
          o
            .setName("alert")
            .setDescription("Alert ID from footer")
            .setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName("dismiss")
        .setDescription("Dismiss an alert")
        .addStringOption((o) =>
          o.setName("alert").setDescription("Alert ID").setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName("alert")
    .setDescription("Test alert presentation")
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName("test")
        .setDescription("Show a private synthetic sample; not a real listing"),
    ),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("View your watch and processing counts")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Preview price, frequency and channel changes")
    .setDMPermission(false)
    .addStringOption((o) =>
      o.setName("id").setDescription("Watch ID").setRequired(true),
    )
    .addNumberOption((o) =>
      o
        .setName("min_price")
        .setDescription("Minimum listing price in USD")
        .setMinValue(0)
        .setMaxValue(10000000),
    )
    .addNumberOption((o) =>
      o
        .setName("max_price")
        .setDescription("Maximum listing price in USD")
        .setMinValue(0)
        .setMaxValue(10000000),
    )
    .addBooleanOption((o) =>
      o
        .setName("clear_price_limits")
        .setDescription("Remove both price limits (applied before new ones)"),
    )
    .addIntegerOption((o) =>
      o
        .setName("frequency")
        .setDescription("Search interval in minutes")
        .setMinValue(60)
        .setMaxValue(10080),
    )
    .addChannelOption((o) =>
      o
        .setName("channel")
        .setDescription("Alert channel")
        .addChannelTypes(ChannelType.GuildText),
    ),
].map((c) => c.toJSON());
