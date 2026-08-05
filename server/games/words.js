// server/games/words.js
// Word data for the games. Two separate banks:
//   RACE  - valid answers for Word Race, checked as a Set
//   DRAW  - drawable prompts for Draw and Guess, split by difficulty
// Stored as space-delimited strings because a 2k-entry JSON array is mostly
// quotes and commas. Split once at boot.

const RACE_WORDS = `
ace ache acid acorn acre act acted actor add added adds adobe adopt adult
afar affair afford afraid after again age aged agent ages ago agree ahead aid
aide aids ail aim aimed aims air aired airy aisle ajar alarm album alert alga
alias alibi alien alike alive all alley allow alloy ally almost alone along
aloud alpha also altar alter amber amble amend amid ammo among ample amuse
anchor and anew angel anger angle angry animal ankle annex annoy answer ant
antic anvil any apart ape apex apple apply apron apt aqua arc arch arctic
are area arena argue arid arise arm armed armor army aroma arose array arrow
art artist ash aside ask asked asleep aspect ass asset atlas atom attach
attack attic audio audit aunt author auto autumn avail avenue avert avoid
await awake award aware away awful awoke axe axis axle
baby back bacon bad badge badly bag bagel bake baked baker bald bale ball
balm band bandit bang bank banjo bank bar barb bare barge bark barn barrel
base basic basil basin basket bass bat batch bath baton batter bay beach
bead beam bean bear beard beast beat beauty beaver became become bed bee beef
been beer beet before began beggar begin begun behalf behind being belief
bell belly below belt bench bend beneath bent berry beside best bet beta
better between beyond bias bid big bike bill bin bind birch bird birth
biscuit bishop bison bit bite bitter black blade blame bland blank blast
blaze bleach bleak bleed blend bless blind blink bliss block blond blood
bloom blot blouse blow blue bluff blunt blur blush board boast boat body
boil bold bolt bomb bond bone bonus book boom boost boot border bore born
borrow boss both bother bottle bottom bought bounce bound bow bowl box boy
brace braid brain brake bran branch brand brass brave bread break breath
breed breeze brew brick bride bridge brief bright brim bring brink brisk
broad broil broke bronze brook broom broth brought brown brush buck bud
budge budget buffalo bug build built bulb bulk bull bullet bump bunch bundle
bunk bunny burden burn burst bury bus bush busy but butter button buy buzz
cab cabin cable cactus cafe cage cake calf call calm came camel camera camp
can canal candle candy cane canoe canvas canyon cap cape car carbon card
care cargo carpet carrot carry cart carve case cash cask cast castle cat
catch cattle caught cause cave cease cedar ceiling cell cement census cent
center cereal chain chair chalk champ chance change chant chaos chap chapter
char charge charm chart chase cheap cheat check cheek cheer cheese chef
cherry chess chest chew chick chief child chill chime chin chip chirp choice
choir choke choose chop chord chore chose chunk church cider cigar cinema
circle circus cite city civic civil claim clam clamp clan clap clash clasp
class claw clay clean clear clerk clever click cliff climb cling clinic clip
cloak clock clone close cloth cloud clover club clue clump clung clutch coach
coal coast coat cobra cocoa code coffee coil coin cold collar colony color
colt column comb combat come comedy comet comfort comic coming comma common
compact company compare compass compete complex concept concert conduct cone
confirm connect consent consist console consult contact contain content
contest context control convert cook cool cope copper copy coral cord core
cork corn corner correct cost cotton couch cough could count county couple
course court cousin cover cow cozy crab crack craft cramp crane crash crate
crawl crazy cream create credit creek creep crest crew crib cried crime crisp
critic crop cross crow crowd crown crude cruel crush crust cry crystal cube
cue cuff cult cup curb cure curl current curse curtain curve cushion custom
cut cute cycle
dad daily dairy daisy dam damage damp dance danger dare dark dart dash data
date dawn day dead deaf deal dean dear death debate debris debt decade decay
deceive decent decide deck declare decline decor decree deep deer defeat
defend defer define degree delay delete deliver delta demand demon denim
dense dent deny depart depend deposit depth derive descend desert deserve
design desire desk detail detect detour device devote diagram dial diamond
diary dice diet differ dig digit dim dime dine dinner dip direct dirt
disaster disc discuss dish disk dismiss display distant ditch dive divide
dizzy dock doctor dodge dog doll dollar dome done donkey donor door dose
dot double doubt dough dove down dozen draft drag dragon drain drama drank
draw drawer dread dream dress drew dried drift drill drink drip drive drop
drove drown drum dry duck duct due dug dull dumb dump dune dusk dust duty
dwarf dwell dye
each eager eagle ear early earn earth ease east easy eat echo edge edit
educate eel effect effort egg eight either elbow elder elect element
elephant elite else email embark ember embrace emerge emit emotion empire
employ empty enable enact end endure enemy energy engage engine enjoy enlist
enough enrich enroll ensure enter entire entry envy equal equip era erase
error erupt escape essay estate etch eternal even event ever every evil exact
exam exceed except excess exchange excite excuse exert exhale exile exist
exit expand expect expert expire explain export expose extend extra eye
fabric face fact factor fade fail faint fair fairy faith fake fall false
fame family famous fan fancy far farm fashion fast fat fate father fault
favor fear feast feather fee feed feel fell fellow felt female fence fern
ferry fetch fever few fiber field fierce fifty fig fight figure file fill
film filter final finance find fine finger finish fire firm first fish fist
fit five fix flag flame flap flash flat flavor flaw flee fleet flesh flew
flex flight fling flint flip float flock flood floor flour flow flower fluid
flush flute fly foam focus fog foil fold folk follow fond food fool foot
force forest forget fork form former fort forth fortune forty forum forward
fossil foster fought found four fox frame free freeze fresh friend fright
fringe frog from front frost frown froze fruit fuel full fun fund funny
furry fuse future
gain gala gallon game gang gap garage garden garlic gas gate gather gauge
gave gaze gear gem gender gene general genius gentle genuine gesture ghost
giant gift giggle ginger giraffe girl give glad glance glare glass glaze
gleam glide glimpse globe gloom glory glove glow glue goal goat gold golf
gone good goose gorge gospel gossip govern gown grab grace grade grain grand
grant grape graph grasp grass grave gravel gray graze great green greet grew
grid grief grill grim grin grind grip grit groan grocer groom groove ground
group grove grow growl grown guard guess guest guide guilt guitar gulf gull
gum gun gust gym
habit hail hair half hall halt ham hammer hand handle hang happen happy
harbor hard hare harm harsh harvest haste hat hatch hate haul haunt have
hawk hay hazard haze head heal health heap hear heart heat heavy hedge heel
height held helium hello helmet help hen herb herd here hero hers hidden
hide high hike hill hint hip hire history hit hive hobby hockey hold hole
holiday hollow holy home honey honor hood hoof hook hope horn horse hose
host hot hotel hound hour house hover howl huge hum human humble humor
hundred hunger hunt hurdle hurry hurt husband hush hut hymn
ice icon idea ideal idle idol ignore ill image imagine impact imply import
impose improve impulse inch include income indeed index indoor infant
inform inhale initial injure ink inland inn inner input insect insert inside
insist inspect install instant instead insult intact intend intense into
invade invent invest invite iron island issue item ivory ivy
jacket jade jail jam jar jaw jazz jeans jelly jet jewel job join joint joke
jolly journal journey joy judge juice jump jungle junior junk jury just
keen keep kept kettle key kick kid kidney kind king kiss kit kitchen kite
kitten knee kneel knew knife knight knit knob knock knot know known
label labor lace lack ladder lady lake lamb lamp land lane language lantern
lap large laser last late laugh launch laundry lava law lawn layer lazy lead
leaf league leak lean leap learn lease least leather leave lecture led ledge
left leg legal legend lemon lend length lens leopard less lesson let letter
lettuce level lever liar liberty library license lid lie life lift light
like lily limb lime limit line linen link lion lip liquid list listen liter
little live lizard load loaf loan lobby local lock lodge log logic lonely
long look loop loose lord lose loss lost lot loud lounge love low loyal luck
lumber lunar lunch lung lure lush luxury lyric
machine mad made magic magnet maid mail main major make male mall mammal man
manage mango manner mansion manual many map maple marble march mare margin
marine mark market marry marsh mask mass master match mate math matter
mature maximum maybe mayor maze meadow meal mean meant measure meat medal
media medium meet melody melon melt member memory men mend mention menu
mercy mere merge merit merry mesh mess metal meter method middle midnight
might mild mile milk mill mind mine mineral mini minor mint minute mirror
miss mist mix mobile mock model modern modest moist mold mole moment money
monitor monkey month mood moon moral more morning most motel moth mother
motion motor mount mouse mouth move movie much mud muffin mule multi muscle
museum music must mustard mute mutual myself mystery myth
nail naive name napkin narrow nasty nation native natural nature naval near
neat neck need needle negative neighbor neither nephew nerve nest net
network neutral never new news next nice nickel niece night nine noble nod
noise none noon nor normal north nose note notice notion novel now nuclear
number nurse nut nylon
oak oath obey object oblige observe obtain obvious occupy occur ocean odd
odor off offer office often oil old olive omit once onion online only onto
open opera opinion oppose option orange orbit orchard order ordinary organ
origin other otter ounce our out outdoor outer outline output outside oval
oven over overlap owe owl own owner oxygen oyster
pace pack pact page paid pail pain paint pair palace pale palm pan panel
panic pant paper parade parcel parent park parrot part partner party pass
past pasta paste pastel pat patch path patient patrol pattern pause pave
paw pay peace peach peak peanut pear pearl pedal peel peer pen penalty
pencil penny people pepper per perch perfect perform perhaps period permit
person pet petal phase phone photo phrase piano pick picnic picture pie
piece pier pig pigeon pile pill pillow pilot pin pinch pine pink pint pioneer
pipe pirate pitch pity pizza place plain plan plane planet plank plant
plaster plastic plate play plaza plea please pledge plenty plot plow plug
plum plumber plunge plus pocket poem poet point poison polar pole police
policy polish polite poll pond pony pool poor pop porch pork port portion
pose position possible post pot potato pouch pound pour powder power praise
pray preach precise prefer prepare present press pretty prevent price pride
prime prince print prior prison private prize probe problem proceed process
produce profit program project promise prompt proof proper propose protect
proud prove provide public pudding puff pull pulse pump punch pupil puppy
pure purple purpose purse push put puzzle
quaint quake quality quarter queen query quest question queue quick quiet
quilt quit quite quiz quote
rabbit race rack radar radio radish raft rag rage raid rail rain raise
rally ramp ranch random range rank rapid rare rat rate rather ratio raw ray
razor reach react read ready real realm reap rear reason rebel recall
receipt receive recent recipe record recover red reduce reef refer reflect
reform refuse regard region regret regular reject relax release relief
remain remark remedy remind remote remove rent repair repeat replace reply
report rescue research reside resist resort resource respect respond rest
result retail retain retire retreat return reveal review revise reward
rhyme rhythm rib ribbon rice rich rid ride ridge rifle right rigid rim ring
rinse riot rip ripe rise risk ritual rival river road roar roast rob robe
robin robot rock rocket rod rode rogue role roll roof room root rope rose
rotate rough round route row royal rub rubber ruby rude rug ruin rule
rumor run rural rush rust
sack sacred sad saddle safe sage said sail saint salad salary sale salmon
salon salt same sample sand sane satin satisfy sauce sausage save saw say
scale scan scar scarce scare scarf scene scent schedule scheme scholar
school science scissor scold scoop scope score scorn scout scrap scrape
scratch scream screen screw script scrub sea seal seam search season seat
second secret section secure seed seek seem seen segment seize seldom select
self sell send senior sense sentence separate sequel series serious serve
session set settle seven severe sew shade shadow shaft shake shall shallow
shame shape share shark sharp shave shed sheep sheer sheet shelf shell
shelter shield shift shine ship shirt shiver shock shoe shoot shop shore
short shot should shoulder shout shove show shower shrimp shrink shrub shrug
shut shy sick side siege sigh sight sign signal silent silk silly silver
similar simple since sincere sing single sink sir sister sit site six size
skate sketch ski skill skin skip skirt skull sky slab slam slang slant
slate slave sled sleep sleeve slender slice slide slight slim slip slope
slot slow slug slump small smart smash smell smile smoke smooth snack snail
snake snap sneak sniff snow soak soap soar sober social sock soda sofa soft
soil solar sold soldier sole solid solve some son song soon sore sorry sort
soul sound soup sour source south space spade span spare spark speak spear
special speech speed spell spend sphere spice spider spill spin spine spirit
spite splash split spoil spoke sponge spoon sport spot spouse spray spread
spring sprout spy square squash squeeze squirrel stable stack staff stage
stain stair stake stale stalk stall stamp stand star stare start state
station statue stay steady steak steal steam steel steep steer stem step
stereo stick stiff still sting stir stitch stock stomach stone stool stop
store storm story stove straight strain strange straw stream street stress
stretch strict strike string strip stroke strong struck struggle stubborn
student studio study stuff stump stun style subject submit subtle succeed
such sudden suffer sugar suggest suit sum summer summit sun super supper
supply support suppose sure surf surface surge surname surplus surprise
surround survey survive suspect swallow swamp swan swap swarm sway swear
sweat sweep sweet swell swept swift swim swing switch sword symbol syrup
system
table tackle tag tail tailor take tale talent talk tall tame tank tape
target task taste tax taxi tea teach team tear tease tech teeth tell temper
temple tempo tend tender tennis tense tent term terrace test text than thank
that thaw theft their them theme then theory there these they thick thief
thin thing think third thirst thirty this thorn those though thought thread
threat three threw thrill throat throne through throw thumb thunder thus
ticket tide tidy tie tiger tight tile till tilt timber time timid tin tiny
tip tire tissue title toast today toe together toil token told toll tomato
tomb tone tongue tonight took tool tooth top topic torch torn toss total
touch tough tour toward towel tower town toy trace track trade traffic
trail train trait tramp trap trash travel tray tread treat tree trend trial
tribe trick tried trim trip triple troop trophy trouble truck true trumpet
trunk trust truth try tube tuck tug tulip tumble tuna tune tunnel turkey
turn turtle twelve twenty twice twig twin twist two type typical
ugly umbrella unable uncle under undo unfair unify union unique unit unite
universe unless unlike until unusual update upgrade uphold upon upper upset
urban urge urgent usage use useful usual utter
vacant vague valid valley value valve van vanish vapor variety various vase
vast vault veil vein velvet vendor venture venue verb verdict verse version
very vessel veteran via vibrate victim victory video view vigor village
vine vinegar violet violin virtue virus visible vision visit visual vital
vivid vocal voice void volume vote vowel voyage
wade wag wage wagon waist wait wake walk wall walnut wander want war
wardrobe warm warn warrant wary was wash wasp waste watch water wave wax
way weak wealth weapon wear weary weather weave web wedge week weekend weep
weigh weight weird welcome weld well went were west wet whale what wheat
wheel when where which while whip whisper whistle white who whole whom whose
why wick wide widow width wife wild will willow win wind window wine wing
wink winter wipe wire wise wish wit witch with within without witness wizard
wolf woman wonder wood wool word work world worm worry worse worship worth
would wound wrap wreck wrench wrist write wrong wrote
yard yarn yawn year yeast yell yellow yes yet yield yoga yolk you young
your youth
zeal zebra zero zigzag zinc zone zoo
`;

// Drawable prompts. Everything here is a concrete thing you can actually put
// on a canvas in eighty seconds. No idioms, no abstract nouns: "cold feet" and
// "social network" read fine in a word list and are miserable to draw.
// Easy is one recognisable shape, medium needs a bit of care, hard is a small
// scene. Multi word prompts use hyphens; prettyPrompt turns them back.

const DRAW_EASY = `
sun moon star cloud rain snow rainbow lightning
tree flower leaf grass bush cactus mushroom log
mountain hill river pond island beach volcano
house door window roof chimney fence gate stairs ladder
road bridge tunnel tent cave barn tower castle

car bus truck taxi van train plane boat bicycle scooter
rocket tractor ambulance helicopter submarine skateboard
traffic-light stop-sign wheel tire steering-wheel

cat dog fish bird duck chicken pig cow sheep horse
rabbit mouse frog turtle snake snail spider ant bee
butterfly ladybug crab shark whale dolphin octopus
lion tiger bear panda monkey elephant giraffe penguin
owl fox wolf deer camel zebra kangaroo dinosaur

apple banana orange lemon grape watermelon strawberry cherry
pear pineapple peach carrot potato tomato corn broccoli
pizza burger hot-dog taco sandwich bread cheese egg
cake cupcake donut cookie candy chocolate popcorn
ice-cream lollipop pancake waffle fries pretzel

cup mug glass bottle bowl plate spoon fork knife
pan pot kettle toaster fridge oven sink
table chair bed couch desk shelf bathtub toilet
lamp candle clock mirror rug pillow blanket
box bag basket bucket gift envelope key lock

shirt pants shorts dress skirt jacket coat
hat cap crown shoe boot sock glove scarf
belt tie glasses sunglasses watch ring necklace

ball balloon kite yo-yo dice card chess-piece
teddy-bear doll toy-car puzzle block
drum guitar piano bell whistle microphone

book pencil pen crayon marker brush paint
eraser ruler scissors glue paper notebook
hammer nail screw saw wrench screwdriver
magnet battery flashlight camera phone computer

heart arrow circle square triangle diamond
flag map coin trophy medal
eye ear nose mouth tooth hand foot
smile sad-face ghost robot alien monster
snowman angel pirate clown wizard
anchor bone feather shell paw-print
umbrella backpack suitcase mailbox
`;

const DRAW_MEDIUM = `
lighthouse windmill treehouse igloo cabin mansion
skyscraper church temple stadium museum library
hospital school factory fire-station police-station
gas-station grocery-store restaurant bakery
playground swimming-pool fountain wishing-well
waterfall canyon desert jungle swamp iceberg

fire-engine garbage-truck food-truck tow-truck
race-car police-car school-bus double-decker-bus
motorcycle dirt-bike unicycle roller-skates
sailboat canoe kayak yacht cruise-ship
fighter-jet hot-air-balloon parachute
forklift bulldozer excavator crane
snowmobile jet-ski spaceship satellite

alligator crocodile hippo rhino gorilla
chimpanzee orangutan koala sloth raccoon
squirrel hedgehog beaver skunk moose
reindeer polar-bear black-bear
peacock flamingo parrot toucan eagle
woodpecker pelican swan turkey rooster
ostrich bat vulture hummingbird
lobster jellyfish seahorse starfish
stingray swordfish pufferfish eel
seal walrus narwhal squid
chameleon iguana gecko salamander
scorpion centipede caterpillar grasshopper
dragonfly praying-mantis beetle mosquito

sunflower rose tulip daisy palm-tree
pine-tree bonsai-tree venus-flytrap
acorn pinecone coconut pumpkin
beehive birdhouse nest spiderweb

birthday-cake wedding-cake gingerbread-man
cotton-candy candy-cane fortune-cookie
spaghetti sushi burrito nachos
fried-chicken bacon sausage meatball
milkshake smoothie teapot coffee-pot

washing-machine dishwasher vacuum-cleaner
lawnmower wheelbarrow trampoline
shopping-cart baby-stroller rocking-chair
bunk-bed office-chair park-bench
ceiling-fan fireplace air-conditioner
alarm-clock hourglass compass thermometer
binoculars telescope microscope magnifying-glass

backpack handbag briefcase wallet
helmet cowboy-hat top-hat sombrero
high-heels slippers rain-boots
bow-tie headphones earmuffs

electric-guitar violin trumpet saxophone
accordion harp xylophone drum-kit
record-player music-note speaker

paint-palette paint-roller stapler hole-punch
calculator keyboard computer-mouse printer
video-camera security-camera remote-control
game-controller walkie-talkie

treasure-chest treasure-map pirate-ship
magic-wand crystal-ball spell-book
sword shield bow-and-arrow cannon
knight helmet armor catapult

campfire sleeping-bag picnic-basket
fishing-rod surfboard snowboard skis
baseball-bat baseball-glove basketball-hoop
football-goal hockey-stick bowling-ball
boxing-glove tennis-racket golf-club

traffic-cone parking-meter street-lamp
fire-hydrant manhole-cover road-sign
railroad-crossing bus-stop phone-booth

snow-globe jack-o-lantern christmas-tree
birthday-present party-hat party-balloon
easter-egg valentine-card
`;

const DRAW_HARD = `
roller-coaster ferris-wheel merry-go-round
water-slide bumper-car haunted-house
maze obstacle-course climbing-wall
bowling-alley movie-theater aquarium
greenhouse observatory planetarium
airport runway train-station subway-station
construction-site shipwreck

monster-truck cement-truck delivery-truck
armored-truck camper-van limousine
convertible race-car formula-one-car
steam-train bullet-train cable-car
airplane-cockpit pirate-ship submarine
spaceship lunar-rover space-shuttle
aircraft-carrier battleship

astronaut scuba-diver firefighter
police-officer construction-worker
chef baker waiter barber
doctor dentist scientist detective
farmer cowboy knight samurai
pirate captain magician juggler
tightrope-walker ballerina drummer
guitar-player skateboarder surfer
skiier snowboarder boxer wrestler
archer goalkeeper race-car-driver

dragon unicorn mermaid centaur
phoenix griffin cyclops minotaur
yeti bigfoot sea-monster
three-headed-dog winged-horse
robot-dog alien-robot space-alien
vampire mummy werewolf zombie
witch-on-a-broom ghost-in-a-sheet

fire-breathing-dragon sleeping-dragon
knight-with-shield pirate-with-parrot
wizard-with-wand astronaut-floating
diver-with-treasure cowboy-on-a-horse
chef-flipping-a-pancake magician-pulling-a-rabbit
clown-juggling-balls monkey-eating-a-banana
dog-catching-a-frisbee cat-climbing-a-tree
frog-catching-a-fly bird-building-a-nest
spider-spinning-a-web snake-in-a-basket
shark-chasing-a-fish octopus-holding-objects
penguin-on-an-iceberg bear-catching-a-fish

volcano-erupting tornado-touching-down
lightning-hitting-a-tree waterfall-with-rainbow
island-with-palm-tree mountain-with-waterfall
cave-with-stalactites iceberg-underwater
desert-with-cactus jungle-waterfall
lighthouse-on-a-cliff castle-on-a-hill
house-on-stilts treehouse-with-ladder
bridge-over-water tunnel-through-mountain

rocket-launch spaceship-landing
satellite-orbiting-earth astronaut-on-the-moon
alien-in-a-spaceship robot-on-a-skateboard
flying-saucer moon-rover solar-system
ringed-planet meteor-shower black-hole

treasure-chest-open treasure-map-with-x
ship-in-a-bottle message-in-a-bottle
sword-in-a-stone crown-on-a-pillow
castle-with-drawbridge pirate-flag
knight-on-a-horse dragon-egg
magic-potion magic-mirror crystal-ball
open-spell-book wizard-hat-with-stars

grand-piano pipe-organ double-bass
marching-drum french-horn bagpipes
dj-turntable karaoke-machine
microphone-on-a-stage concert-speakers

vending-machine arcade-machine pinball-machine
claw-machine slot-machine photo-booth
gumball-machine popcorn-machine
cash-register ATM-machine ticket-machine
elevator escalator revolving-door
shopping-cart-full-of-food

washing-machine-with-clothes vacuum-cleaner
sewing-machine typewriter grandfather-clock
cuckoo-clock rotary-phone film-projector
record-player jukebox old-camera
toolbox-full-of-tools swiss-army-knife
first-aid-kit fire-extinguisher

breakfast-plate picnic-table
birthday-table tea-party
stack-of-pancakes bowl-of-spaghetti
pizza-with-toppings hamburger-with-fries
ice-cream-sundae chocolate-fountain
gingerbread-house fruit-basket
roast-turkey sushi-platter

football-player-kicking basketball-player-dunking
baseball-player-batting tennis-player-serving
golfer-swinging hockey-goalie
boxer-punching weightlifter-lifting
skateboarder-jumping surfer-on-a-wave
skiier-going-downhill snowboarder-jumping
archer-shooting target-with-arrow

sandcastle-with-flag snowman-with-hat
kite-stuck-in-a-tree balloon-floating-away
umbrella-in-the-wind candle-blowing-out
melting-ice-cream broken-heart
bursting-balloon cracked-egg
open-gift-box overflowing-backpack

traffic-jam car-with-flat-tire
tow-truck-pulling-a-car train-crossing-a-bridge
plane-flying-over-clouds boat-in-big-waves
sailboat-in-the-wind helicopter-rescue
fire-truck-spraying-water ambulance-with-siren
tractor-pulling-a-trailer bulldozer-moving-dirt

camping-tent-with-fire picnic-under-a-tree
fisherman-catching-a-fish person-flying-a-kite
child-on-a-swing person-riding-a-bike
person-walking-a-dog person-reading-a-book
person-taking-a-photo person-painting-a-picture
person-opening-a-present person-building-a-snowman
`;

function split(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

const RACE = new Set(split(RACE_WORDS));
const DRAW = {
  easy: split(DRAW_EASY),
  medium: split(DRAW_MEDIUM),
  hard: split(DRAW_HARD),
};

function isRaceWord(word) {
  return RACE.has(String(word || "").toLowerCase());
}

// Prompts are shown to the drawer with the hyphens turned back into spaces.
function prettyPrompt(word) {
  return String(word || "").replace(/-/g, " ");
}

module.exports = { RACE, DRAW, isRaceWord, prettyPrompt };
